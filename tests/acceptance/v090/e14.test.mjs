import {pathToFileURL as collectorPathToFileURL} from 'node:url';
import {resolve as collectorResolve} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import {openScenario,sha} from './support.mjs';
import {openMaintenance} from './maintenance.mjs';

const cases=['E14.journey','E14.variant.01','E14.variant.02','E14.variant.03','E14.variant.04'];
function body(result){
 // App Server preserves MCP tool results. Do not infer success from a string
 // containing the selected version or from discovery alone.
 assert(result&&typeof result==='object');assert.notEqual(result.isError,true);
 const value=result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text);
 assert(!value.error);return value;
}
async function verifiedHost(f){
 const host=await f.host(),discovery=await host.inspect();assert.deepEqual(discovery.servers.map(s=>s.name),['evopilot_runtime']);
 const server=discovery.servers[0];assert.equal(server.runtimeStatus,'connected');assert.equal(server.httpOrigin,'http://127.0.0.1:'+f.plan.port);assert.deepEqual(server.tools,['runtime_read','runtime_write']);assert.equal(discovery.skillResolvedByActualHost,true);assert.equal(discovery.skillBytesVerifiedAgainstPackage,true);assert.equal(discovery.actualModelTurn,false);
 const response=body(await host.tool('evopilot_runtime','runtime_read',{operation:'runtime.status',projectId:f.plan.projectId,input:{}})),identity=response.result;
 const native=await f.read('runtime.status');assert.equal(identity.serviceId,native.serviceId);assert.equal(identity.workspaceId,f.plan.workspaceId);assert.equal(identity.projectId,f.plan.projectId);assert.equal(identity.version,native.version);assert.equal(identity.contract,'runtime-service/v1');
 return{host,discovery,identity};
}
async function installed(f){
 const value=await f.command('install');assert.equal(value.body.phase,'AWAITING_HOST_VERIFICATION');assert.equal(value.body.hostRegistered,true,'A staged plugin or codex:null does not prove registration');assert.equal(value.body.hostVerification,'NOT_EVALUATED');assert.equal(value.body.service.running,true);return value.body;
}
async function retainDraft(f,run,c){
 const before=await f.read('lifecycle.definition.inspect'),yaml='schema: runtime-project-lifecycle/v1\nprojectId: '+f.plan.projectId+'\n',requestId=run.requestId(c.caseInstanceId,'retention-draft');
 const result=await f.write('lifecycle.draft.save',{yaml},requestId,before.revision);assert.equal(result.result.status,'DRAFT');
 const receipt=await f.read('runtime.receipt.read',{requestId}),view=await f.read('lifecycle.definition.inspect');assert.equal(view.active,null,'Maintenance does not activate a Project Lifecycle');assert(view.draft);
 return{requestId,receipt,draftId:view.draft.id??view.draft.revisionId,yaml};
}
async function retained(f,record){
 assert.deepEqual(await f.read('runtime.receipt.read',{requestId:record.requestId}),record.receipt);
 const view=await f.read('lifecycle.definition.inspect');assert.equal(view.active,null);assert.equal(view.draft.id??view.draft.revisionId,record.draftId);
 const source=await f.read('lifecycle.definition.source.read',{revisionId:record.draftId});assert.equal(Buffer.from(source.data,'base64').toString(),record.yaml);assert.equal(source.nextOffset,null);
}
async function unavailableHost(host,projectId){
 let result,error;try{result=await host.tool('evopilot_runtime','runtime_read',{operation:'runtime.status',projectId,input:{}});}catch(caught){error=caught;}
 if(!error){assert(result?.isError||result?.error||result?.structuredContent?.error,'A stopped service must not return a successful cached Runtime identity');}
 return{failed:true,classification:error?'ACTUAL_HOST_TRANSPORT_REJECTION':'ACTUAL_MCP_ERROR',successfulCachedRead:false};
}
async function portConflict(f){
 await f.command('stop');const sentinel='e14-foreign-port-'+sha(f.plan.root).slice(0,16),listener=createServer((_request,response)=>{response.writeHead(200,{'content-type':'text/plain'});response.end(sentinel);});
 await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(f.plan.port,'127.0.0.1',resolve);});
 try{
  const refusal=await f.command('start',true);assert.notEqual(refusal.exitCode,0);assert(['SERVICE_NOT_READY','SERVICE_IDENTITY_CONFLICT'].includes(refusal.body.error?.code));
  const url='http://127.0.0.1:'+f.plan.port;assert.equal(await(await fetch(url,{signal:AbortSignal.timeout(3000)})).text(),sentinel);
  const log=fs.readFileSync(path.join(f.plan.root,'service.stdout.log'),'utf8');assert(log.includes('PORT_IN_USE'),'Original process startup receipt must identify the occupied port');
  f.save('maintenance-port-conflict.json',{nativeFailure:refusal.body.error.code,portInUseReceipt:true,foreignListenerSurvives:true,sentinelDigest:sha(sentinel),stdoutDigest:sha(log)});
  // Stop only our loaded failed launchd job, while the independent listener is
  // still alive, proving cleanup cannot stop the unrelated port owner.
  await f.command('stop');assert.equal(await(await fetch(url,{signal:AbortSignal.timeout(3000)})).text(),sentinel);
 }finally{await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));}
 const resumed=await f.command('start');assert.equal(resumed.body.service.running,true);return{foreignListenerPreserved:true,originalPortFailureRetained:true,recoveredOwnedService:true};
}
async function primary(f,run,c){
 const first=await installed(f),observed=await verifiedHost(f),record=await retainDraft(f,run,c);
 await observed.host.close();const afterHost=await f.read('runtime.status');assert.equal(afterHost.serviceId,first.service.identity.serviceId);
 const again=await f.command('start');assert.equal(again.body.service.pid,first.service.pid);assert.equal(again.body.service.identity.serviceId,first.service.identity.serviceId);
 const duplicate=await f.execute([path.join(f.plan.root,'package/dist/server/cli.js'),'serve','--state-root',path.join(f.plan.root,'data'),'--workspace-id',f.plan.workspaceId,'--port',String(f.plan.port)]);
 assert.notEqual(duplicate.exitCode,0);assert.equal(duplicate.signal,null);assert.equal(JSON.parse(duplicate.stdout).error.code,'WRITER_ACTIVE');assert.equal((await f.read('runtime.status')).serviceId,first.service.identity.serviceId);
 const conflict=await portConflict(f);await retained(f,record);const restarted=await verifiedHost(f);assert.equal(restarted.identity.serviceId,first.service.identity.serviceId);
 return{actualInstallerRegistration:true,actualHostSkillDiscovery:true,exactSkillBytesVerified:true,actualHostHttpRead:true,actualModelTurn:false,serviceSurvivesHostExit:true,repeatedStartSamePid:true,duplicateWriterRejected:true,...conflict,receiptPreserved:true};
}
async function pluginFailure(f,run,c){
 const staged=await f.command('stage');assert.equal(staged.body.phase,'STAGED');assert.equal(staged.body.serviceStarted,false);
 const conflict=path.join(f.plan.root,'plugin/.codex-plugin/plugin.json'),fault=Buffer.from('{"name":"e14-owned-conflicting-plugin"}\n');fs.mkdirSync(path.dirname(conflict),{recursive:true,mode:0o700});fs.writeFileSync(conflict,fault,{mode:0o600,flag:'wx'});
 const failed=await f.command('install',true);assert.notEqual(failed.exitCode,0);assert.equal(failed.body.error?.code,'INSTALLATION_CHANGED');
 const native=await f.module('installation/service'),spec=JSON.parse(fs.readFileSync(path.join(f.plan.root,'service-specification.json'))),running=await native.observeUserService(spec);assert.equal(running.running,true);assert(running.identity);
 f.save('maintenance-plugin-partial-failure.json',{faultKind:'OWNED_GENERATED_PLUGIN_CONFLICT',path:conflict,faultSha256:sha(fault),serviceId:running.identity.serviceId,serviceRunning:true,hostInstallationSucceeded:false,originalInstallerError:failed.body.error.code});
 assert.deepEqual(fs.readFileSync(conflict),fault);fs.unlinkSync(conflict); // Only this exact injected file; original error/audit remain.
 const recovered=await installed(f);assert.equal(recovered.service.identity.serviceId,running.identity.serviceId);const observed=await verifiedHost(f),record=await retainDraft(f,run,c);await retained(f,record);
 return{actualPartialPluginFailure:true,faultKind:'GENERATED_PLUGIN_MATERIAL_CONFLICT',servicePreserved:true,samePlanRecovery:true,actualInstallerRegistration:true,actualHostRecovery:true,actualHostSkillDiscovery:observed.discovery.skillResolvedByActualHost,actualModelTurn:false};
}
async function serviceFailure(f,run,c){
 const first=await installed(f),observed=await verifiedHost(f),record=await retainDraft(f,run,c);await f.command('stop');const rejected=await unavailableHost(observed.host,f.plan.projectId);
 const resumed=await f.command('start');assert.equal(resumed.body.service.identity.serviceId,first.service.identity.serviceId);
 const response=body(await observed.host.tool('evopilot_runtime','runtime_read',{operation:'runtime.status',projectId:f.plan.projectId,input:{}}));assert.equal(response.result.serviceId,first.service.identity.serviceId);await retained(f,record);
 return{pluginRegisteredBeforeFailure:true,actualHostUnavailableServiceRejection:rejected,sameHostRestoredRead:true,sameServiceIdentity:true,receiptPreserved:true,actualModelTurn:false};
}
async function mismatch(f,run,c){
 await installed(f);const before=await verifiedHost(f),record=await retainDraft(f,run,c),connectionBytes=fs.readFileSync(path.join(f.plan.root,'connection.json')),connection=JSON.parse(connectionBytes),ref=path.join(f.caseRoot,'wrong-version-connection.json');
 const wrong={...connection,version:connection.version==='99.0.0'?'98.0.0':'99.0.0'};fs.writeFileSync(ref,JSON.stringify(wrong)+'\n',{mode:0o600,flag:'wx'});
 const plugin=await f.module('host/plugin');let materialError;try{plugin.runtimePluginMaterial(path.join(f.plan.root,'package'),ref,f.plan.nodeExecutable);}catch(error){materialError=error.code;}
 assert.equal(materialError,'PLUGIN_VERSION_MISMATCH','The exact native delivery helper must reject plugin/package/service version disagreement');
 let serviceError;try{await(await f.client(ref)).status();}catch(error){serviceError=error.code;}
 assert.equal(serviceError,'SERVICE_IDENTITY_CHANGED','A live HTTP response must disagree with the selected wrong version');
 f.save('maintenance-version-mismatch.json',{connectionReference:ref,connectionSha256:sha(fs.readFileSync(ref)),actualVersion:connection.version,wrongExpectedVersion:wrong.version,pluginMaterialError:materialError,actualHttpIdentityError:serviceError,installedPluginAndPackageUnmodified:true,classification:'NATIVE_INSTALLED_DELIVERY_GUARD_AND_ACTUAL_HTTP_IDENTITY_NOT_FAKE_RELEASE'});
 await before.host.close();const restored=await verifiedHost(f);assert.equal(restored.identity.serviceId,connection.serviceId);await retained(f,record);assert.deepEqual(fs.readFileSync(path.join(f.plan.root,'connection.json')),connectionBytes);
 return{nativePluginVersionGuard:materialError,actualHttpVersionGuard:serviceError,actualMatchingSkillAndHostRecovery:true,originalConnectionUnchanged:true,receiptPreserved:true,actualModelTurn:false};
}
async function refresh(f,run,c){
 await installed(f);const old=await verifiedHost(f),record=await retainDraft(f,run,c);await f.command('stop');const failure=await unavailableHost(old.host,f.plan.projectId);await old.host.close();
 const recovered=await installed(f);assert.equal(recovered.hostVerification,'NOT_EVALUATED');assert.equal(recovered.phase,'AWAITING_HOST_VERIFICATION');
 f.save('maintenance-refresh-pending.json',{installerPhase:recovered.phase,hostVerification:recovered.hostVerification,previousHostClosed:true,previousHostFailure:failure,actualHostReadbackStillRequired:true});
 const fresh=await verifiedHost(f);assert.notEqual(fresh.discovery.threadId,old.discovery.threadId);assert.equal(fresh.identity.serviceId,old.identity.serviceId);await retained(f,record);
 return{actualOldConnectionFailedAndClosed:true,installerNeverInferredHostSuccess:true,explicitFreshHostConnection:true,newEphemeralThread:true,actualSkillAndHttpReadback:true,receiptPreserved:true,actualModelTurn:false};
}

export async function executeE14() {
 const run=await openScenario('E14');let maintenance;
 try{
  assert.equal(process.platform,'darwin','These fixed installed user-service cases require the actual macOS launchd Host');assert(run.cases.every(c=>cases.includes(c.caseInstanceId)));maintenance=openMaintenance(run);
  for(const c of run.cases)await run.collect(c,async()=>{
   const f=await maintenance.create(c);let result;
   try{result=await({'E14.journey':primary,'E14.variant.01':pluginFailure,'E14.variant.02':serviceFailure,'E14.variant.03':mismatch,'E14.variant.04':refresh}[c.caseInstanceId])(f,run,c);}
   finally{await f.close();}
   return{...result,actualInstalledCandidate:true,sourceTestsCounted:false,uninstallRetainsDataCredentialsAndAudit:true,ownedServiceStopped:true,actualPluginUnregistered:true,dailyInstallationChanged:false,expertDialogueClaimed:false};
  });
 }finally{run.finish();}
}
if(process.argv[1]&&collectorPathToFileURL(collectorResolve(process.argv[1])).href===import.meta.url)test('E14 five fixed installed service and actual Codex maintenance cases',executeE14);
