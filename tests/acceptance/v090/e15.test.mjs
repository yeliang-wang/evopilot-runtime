import {registerFixedScenario} from './preflight.mjs';
import {pathToFileURL as collectorPathToFileURL} from 'node:url';
import {resolve as collectorResolve} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {openScenario,repository,sha} from './support.mjs';
import {openInstalledHost} from './maintenance.mjs';

// The selected migrated installation and synthetic owner assets are prepared
// separately. This collector never starts a source service, imports owner source,
// adopts daily state, publishes assets, or reuses an old development report.
const exact=(value,keys)=>{assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...keys].sort());};
const read=filename=>JSON.parse(fs.readFileSync(filename));
function canonical(filename){assert(path.isAbsolute(filename)&&path.resolve(filename)===filename);assert.equal(fs.realpathSync(filename),filename);return filename;}
function protectedReference(pin){
 exact(pin,['ref','sha256']);canonical(pin.ref);assert(/^[a-f0-9]{64}$/.test(pin.sha256));
 const stat=fs.lstatSync(pin.ref);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.uid===process.getuid()&&(stat.mode&0o777)===0o600&&stat.size<=131072);
 const bytes=fs.readFileSync(pin.ref);assert.equal(sha(bytes),pin.sha256);return JSON.parse(bytes);
}
function inside(filename,root,missing=false){
 assert(path.isAbsolute(filename)&&path.resolve(filename)===filename&&filename.startsWith(root+path.sep),'Compatibility state must remain inside the selected isolated root');
 canonical(missing?path.dirname(filename):filename);return filename;
}
function toolResult(raw){
 assert(raw&&typeof raw==='object');assert.notEqual(raw.isError,true,JSON.stringify(raw));
 const value=raw.structuredContent??JSON.parse(raw.content.find(part=>part.type==='text').text);assert(!value.error,JSON.stringify(value.error));return value;
}

export async function executeE15(callableContext) {
 const run=await openScenario('E15',undefined,callableContext);let host;
 try{
  for(const c of run.cases)await run.collect(c,async()=>{
   assert.equal(c.caseInstanceId,'E15.journey');assert(run.selection.legacyCompatibility,'Select a current exact isolated legacy compatibility plan');
   const selected=protectedReference(run.selection.legacyCompatibility);
   exact(selected,['schema','candidateDigest','workspaceId','projectId','serviceId','isolatedRoot','codexHome','ownerConfig','fixture','allowSyntheticWrites']);
   assert.equal(selected.schema,'runtime-e15-compatibility-selection/v1');assert.equal(selected.candidateDigest,run.candidateDigest);
   for(const key of ['workspaceId','projectId','serviceId'])assert.equal(selected[key],run.candidate[key]);
   assert.equal(selected.allowSyntheticWrites,true,'Only explicit isolated technical validation and a synthetic goal are in scope');
   canonical(selected.isolatedRoot);const directory=fs.lstatSync(selected.isolatedRoot);assert(directory.isDirectory()&&directory.uid===process.getuid()&&(directory.mode&0o777)===0o700);
   assert(!repository.startsWith(selected.isolatedRoot+path.sep)&&!selected.isolatedRoot.startsWith(repository),'Source checkout is not an isolated fixture root');
   inside(run.selection.installedRoot,selected.isolatedRoot);inside(selected.codexHome,selected.isolatedRoot,true);
   assert(selected.codexHome!==process.env.CODEX_HOME&&selected.codexHome!==path.join(process.env.HOME,'.codex'),'Do not select the daily Codex home');
   inside(selected.fixture.ref,selected.isolatedRoot);inside(selected.ownerConfig.ref,selected.isolatedRoot);
   const fixture=protectedReference(selected.fixture),ownerConfig=protectedReference(selected.ownerConfig),installation=read(path.join(run.selection.installedRoot,'installation-plan.json'));
   assert.equal(fixture.schema,'runtime-published-owner-fixture/v1');assert.equal(fixture.syntheticAssets,true);assert.equal(fixture.syntheticDecisions,true);assert.equal(fixture.realOwnerPackages,'0.8.3');
   assert.equal(fixture.workspaceId,selected.workspaceId);assert.deepEqual(fixture.scope,{visibility:'private',projectId:selected.projectId});inside(fixture.workspaceRoot,selected.isolatedRoot);
   assert(fixture.readiness?.assessmentId&&fixture.readiness.intentDigest,'Select the isolated historical owner combination, including its Runtime intent');
   assert(installation.legacyMigration&&installation.legacyOwnerHost&&installation.codex,'Use the selected installed migration, owner routes and single Codex plugin');
   assert.equal(installation.root,run.selection.installedRoot);assert.equal(installation.legacyMigration.workspaceRoot,fixture.workspaceRoot);assert.equal(installation.legacyOwnerHost.ref,selected.ownerConfig.ref);
   assert.equal(installation.codex.executable,run.selection.codexHost?.executable);assert.equal(installation.codex.sha256,run.selection.codexHost.executableSha256);
   const packageRoot=path.join(run.selection.installedRoot,'package'),load=name=>import(pathToFileURL(path.join(packageRoot,name)).href);
   const [owners,ownerHost,errors,pluginApi]=await Promise.all([load('dist/adapters/published-owners.js'),load('dist/host/legacy-owners.js'),load('dist/server/errors.js'),load('dist/host/plugin.js')]);
   assert.deepEqual(ownerHost.readLegacyOwnerHostConfiguration(selected.ownerConfig.ref),ownerConfig);assert.equal(errors.digest(ownerConfig),installation.legacyOwnerHost.digest);
   const binding=read(path.join(run.selection.installedRoot,'legacy-binding.json'));
   assert.equal(ownerConfig.legacyBindingRef,path.join(run.selection.installedRoot,'legacy-binding.json'));assert.equal(binding.workspaceRoot,fixture.workspaceRoot);assert.equal(binding.workspaceId,selected.workspaceId);assert.equal(binding.serviceId,selected.serviceId);
   for(const key of ['workspaceId','projectId'])assert.equal(ownerConfig[key],selected[key]);
   assert(ownerConfig.nativeToolchain,'The native owner validators need the selected real local toolchain');
   const versionMatrix={runtime:run.candidate.version,owners:{}};
   const requiredCalls=['request:workspace.inspect','native:standard.inspect','native:native.package.readback','native:native.package.validate','native:native.receipt.inspect'];
   for(const owner of ['ontology','harness']){
    assert.equal(ownerConfig.owners[owner].packageRoot,fixture.packageRoots[owner]);
    const expected=[...requiredCalls,owner==='harness'?'native:readiness.assessment.read':'native:readiness.package.inspect'];
    assert.deepEqual([...ownerConfig.owners[owner].calls].sort(),expected.sort(),'Select only the fixed legacy read/native-validation permissions');
    const verified=owners.verifyOwnerDistribution(owner,fixture.packageRoots[owner]),identity=owners.ownerDistributionIdentity(owner);assert.equal(verified.version,'0.8.3');assert.equal(identity.version,'0.8.3');versionMatrix.owners[owner]={...verified,releaseUrl:identity.releaseUrl};
   }
   const metadata=read(path.join(packageRoot,'package.json'));assert.equal(metadata.name,'@evopilot-next/runtime');assert.equal(metadata.version,run.candidate.version);assert.equal(metadata.bin['evopilot-runtime'],'dist/server/cli.js');
   const material=pluginApi.runtimePluginMaterial(packageRoot,run.selection.connectionRef,installation.nodeExecutable,{ownerConfigRef:selected.ownerConfig.ref,ownerConfigDigest:installation.legacyOwnerHost.digest});
   for(const [relative,bytes] of material.files)assert.deepEqual(fs.readFileSync(path.join(run.selection.installedRoot,'plugin',relative)),bytes,'Installed plugin content differs from its exact package and owner selection');
   const mcp=JSON.parse(material.files.get('.mcp.json'));assert.deepEqual(Object.keys(mcp.mcpServers).sort(),['evopilot_runtime','evopilot_runtime_legacy']);
   assert.equal(mcp.mcpServers.evopilot_runtime.type,'http');assert.equal(mcp.mcpServers.evopilot_runtime.url,run.serviceOrigin+'/mcp');assert.equal(mcp.mcpServers.evopilot_runtime_legacy.command,installation.nodeExecutable);
   assert.deepEqual(mcp.mcpServers.evopilot_runtime_legacy.args,[path.join(packageRoot,'dist/host/bridge.js'),'--connection-ref',run.selection.connectionRef,'--legacy-only','--owner-config-ref',selected.ownerConfig.ref,'--owner-config-digest',installation.legacyOwnerHost.digest]);
   run.artifact('legacy-current-selection.json',{selected,fixtureReference:selected.fixture,ownerConfigReference:selected.ownerConfig,versionMatrix,pluginServers:mcp.mcpServers,candidateDigest:run.candidateDigest,syntheticAssets:true,syntheticDecisions:true,historicalResultsReused:false});

   const identity=await run.read('runtime.status');assert.equal(identity.legacy?.bound,true);assert.equal(identity.legacy.migrationDigest,binding.migrationDigest);
   const definitionBefore=await run.read('lifecycle.definition.inspect');
   host=await openInstalledHost(run,{installedRoot:run.selection.installedRoot,codexHome:selected.codexHome,codex:run.selection.codexHost,nodeExecutable:installation.nodeExecutable,projectId:selected.projectId,workspaceId:selected.workspaceId,serviceId:selected.serviceId,version:run.candidate.version,expectedServers:['evopilot_runtime','evopilot_runtime_legacy'],allowLegacyGoalCreate:true});
   const discovery=await host.inspect();assert.equal(discovery.actualCodexHost,true);assert.equal(discovery.actualModelTurn,false);assert.equal(discovery.skillResolvedByActualHost,true);assert.equal(discovery.skillBytesVerifiedAgainstPackage,true);
   assert.deepEqual(discovery.servers.map(server=>server.name).sort(),['evopilot_runtime','evopilot_runtime_legacy']);
   const modern=discovery.servers.find(server=>server.name==='evopilot_runtime'),legacy=discovery.servers.find(server=>server.name==='evopilot_runtime_legacy');
   assert.equal(modern.httpOrigin,run.serviceOrigin);assert.equal(modern.pluginId,legacy.pluginId);assert.equal(legacy.serverInfo.name,'evopilot-runtime-stdio-bridge');assert.equal(legacy.serverInfo.version,run.candidate.version);
   assert(modern.tools.includes('runtime_read')&&modern.tools.includes('runtime_write'));assert(!legacy.tools.includes('runtime_read')&&!legacy.tools.includes('runtime_write'));
   for(const name of ['inspect','activate','deactivate','capabilities','request','native'])assert(legacy.tools.includes('evopilot_v01_'+name));
   async function legacyCall(name,args={}){
    const response=toolResult(await host.tool(legacy.name,'evopilot_v01_'+name,args));assert.equal(response.namespace,'evopilot-runtime-legacy');assert.equal(response.authority,false);
    for(const key of ['workspaceId','projectId','serviceId'])assert.equal(response.connection[key],selected[key]);assert.equal(response.connection.version,run.candidate.version);
    assert.match(response.migrationNotice,/independent HTTP service/);assert.match(response.migrationNotice,/legacy records do not activate a Project Lifecycle/);return response;
   }
   const passive=await legacyCall('inspect');assert.equal(passive.result.connected,true);assert.equal(passive.sessionActive,false);
   const activation=await legacyCall('activate');assert.equal(activation.result.serviceStarted,false);assert.equal(activation.result.activated,true);
   const capabilities=await legacyCall('capabilities');assert.equal(capabilities.result.revisionNamespace,'original-family');assert.equal(capabilities.result.ownerAuthoring,false);assert.equal(capabilities.result.softwareLifecycleAuthority,false);
   assert.equal(capabilities.result.ownerEntries.runtimeHttpAuthoring,false);assert.equal(capabilities.result.ownerEntries.semanticApproval,false);assert.equal(capabilities.result.ownerEntries.softwareRelease,false);
   const primaryIdentity=toolResult(await host.tool(modern.name,'runtime_read',{operation:'runtime.status',projectId:selected.projectId,input:{}})).result;assert.equal(primaryIdentity.serviceId,selected.serviceId);assert.deepEqual(primaryIdentity.legacy,identity.legacy);
   const scope=fixture.scope,legacyRead=(operation,input={})=>legacyCall('request',{owner:'runtime',envelope:{operation,scope,input}}),httpRead=(operation,input={})=>run.read('runtime.legacy.read',{family:'request',envelope:{operation,scope,input}});
   const project=await legacyRead('project.inspect');assert.deepEqual(project.result,await httpRead('project.inspect'));assert.deepEqual(project.result.scope,scope);
   const runsBefore=await httpRead('run.list'),original=await legacyRead('workspace.inspect'),transportBefore=await run.read('runtime.status');
   const requestId=run.requestId(c.caseInstanceId,'legacy-goal'),goalId=run.requestId(c.caseInstanceId,'goal-id');
   const envelope={operation:'goal.create',scope,input:{id:goalId,description:'Synthetic E15 transport compatibility only; no business Run or release'},requestId,expectedRevision:original.result.revision};
   const created=await legacyCall('request',{owner:'runtime',envelope});assert.equal(created.result.requestId,requestId);assert.equal(created.result.revision,original.result.revision+1);assert.deepEqual(created.result.result.scope,scope);
   assert.deepEqual((await legacyRead('receipt.inspect',{requestId})).result,created.result);assert.deepEqual(await httpRead('receipt.inspect',{requestId}),created.result);
   assert.deepEqual((await legacyRead('goal.inspect',{id:goalId})).result,await httpRead('goal.inspect',{id:goalId}));
   const {requestId:originalRequestId,expectedRevision,...originalEnvelope}=envelope;
   const replay=await run.request('runtime.legacy.write',{family:'request',envelope:originalEnvelope},{requestId:originalRequestId,expectedRevision});assert.equal(replay.status,200);assert.deepEqual(replay.body.result,created.result);
   assert.equal((await legacyRead('workspace.inspect')).result.revision,original.result.revision+1);assert.equal((await run.read('runtime.status')).revision,transportBefore.revision+1);
   run.artifact('legacy-same-receipt.json',{requestId,goalId,legacyReceipt:created.result,httpReplay:replay.body.result,legacyRevisionBefore:original.result.revision,legacyRevisionAfter:original.result.revision+1,transportAdmissionEvents:1,originalFamilyCanonical:true});

   const ownerResults=[];
   for(const owner of ['ontology','harness']){
    const reference=fixture.references[owner],input={id:reference.id,version:reference.version};
    const ownerCall=(entry,operation,value={},meta={})=>legacyCall(entry,{owner,envelope:{operation,scope,input:value,...meta}});
    const standard=await ownerCall('native','standard.inspect');assert.equal(standard.result.contractDigest,reference.contractDigest);
    const pkg=await ownerCall('native','native.package.readback',input);assert.deepEqual(pkg.result.reference,reference);assert.equal(pkg.delegation.owner,owner);assert.equal(pkg.delegation.runtimeHttpAuthoring,false);assert.equal(pkg.delegation.transport,'local-published-owner-api');
    if(owner==='harness')assert.deepEqual(pkg.result.package.manifest.dependencies.find(value=>value.product==='ontology'&&value.id===fixture.references.ontology.id),fixture.references.ontology,'Harness validation must resolve the real selected Ontology dependency');
    const before=await ownerCall('request','workspace.inspect'),nativeRequestId=run.requestId(c.caseInstanceId,'validate-'+owner),meta={requestId:nativeRequestId,expectedRevision:before.result.revision};
    const absent=await host.tool(legacy.name,'evopilot_v01_native',{owner,envelope:{operation:'native.receipt.inspect',scope,input:{requestId:nativeRequestId}}});
    const absentBody=absent.structuredContent??JSON.parse(absent.content.find(part=>part.type==='text').text);assert.equal(absent.isError,true);assert.equal(absentBody.error?.code,'NOT_FOUND','This attempt must execute a new native validation, not borrow an existing receipt');
    // Published 0.8.3 owners first commit a durable RUNNING claim, then commit
    // completion under the same request: exactly two owner revisions. Reads
    // and an exact replay must not commit either phase again.
    const completedRevision=before.result.revision+2;
    const validation=await ownerCall('native','native.package.validate',input,meta);assert.equal(validation.result.requestId,nativeRequestId);assert.equal(validation.result.revision,completedRevision);assert.equal(validation.result.result.toolchainLockDigest,ownerConfig.nativeToolchain.lockDigest);
    assert.equal((await ownerCall('request','workspace.inspect')).result.revision,completedRevision);
    if(owner==='ontology'){
     assert.equal(validation.result.result.status,'CONFORMS');const process=validation.result.result.process;assert.equal(process.exitCode,0);assert.equal(process.signal,null);assert.equal(process.timedOut,false);assert(validation.result.result.caseReports.length>0&&validation.result.result.caseReports.every(item=>item.matchesExpected===true));
    }else{
     assert.equal(validation.result.status,'SUCCEEDED');assert.equal(validation.result.result.qualityStatus,'PASS');assert(validation.result.result.commands.length>0&&validation.result.result.commands.every(command=>Number.isInteger(command.exitCode)&&command.signal===null&&!command.timedOut&&!command.outputLimit));assert(validation.result.result.rawReports.length>0);
    }
    const receipt=await ownerCall('native','native.receipt.inspect',{requestId:nativeRequestId});assert.deepEqual(receipt.result,validation.result);
    const repeated=await ownerCall('native','native.package.validate',input,meta);assert.deepEqual(repeated.result,validation.result);assert.equal((await ownerCall('request','workspace.inspect')).result.revision,completedRevision);
    const afterPackage=await ownerCall('native','native.package.readback',input);assert.deepEqual(afterPackage.result.reference,reference);
    if(owner==='ontology'){assert.equal(afterPackage.result.claim.requestId,nativeRequestId);assert.equal(afterPackage.result.claim.status,'COMPLETE');assert.equal(afterPackage.result.claim.attempt,(pkg.result.claim?.attempt??0)+1);}
    assert.equal((await ownerCall('request','workspace.inspect')).result.revision,completedRevision);
    ownerResults.push({owner,requestId:nativeRequestId,revisionBefore:before.result.revision,revision:validation.result.revision,ownerCommitPhases:['RUNNING_CLAIM','COMPLETION'],newRequestWasAbsent:true,readsAndReplayAdvancedRevision:false,reportDigest:validation.result.result.reportDigest,actualNativeValidation:true,exactReplay:true});
   }
   const readiness=await legacyCall('native',{owner:'harness',envelope:{operation:'readiness.assessment.read',scope,input:{standardVersion:'v2',id:fixture.readiness.assessmentId}}});
   assert.equal(readiness.result.result.intentDigest,fixture.readiness.intentDigest);assert.equal(readiness.result.result.projectionDigest,fixture.readiness.projectionDigest);assert.equal(readiness.result.result.assetAssessment.freshness,'CURRENT');assert.equal(readiness.result.result.assetAssessment.evidenceOrigin,'SYNTHETIC');
   const intent=await run.read('runtime.legacy.read',{family:'readiness',envelope:{operation:'readiness.intent.read',scope,input:{standardVersion:'v2',digest:fixture.readiness.intentDigest}}});assert.equal(intent.digest,fixture.readiness.intentDigest);assert.equal(intent.current,true);
   const runtimeApi=await load('dist/service.js'),otherWriter=runtimeApi.createRuntimeService({workspaceRoot:fixture.workspaceRoot,workspaceId:selected.workspaceId});let writerFailure;
   try{otherWriter.initialize();}catch(error){writerFailure={code:error.code,message:error.message};}finally{otherWriter.close();}
   run.artifact('legacy-writer-boundary.json',{entry:path.join(packageRoot,'dist/service.js'),scope,writerFailure,meaning:'The installed compatibility factory cannot open another managed Runtime writer'});assert.equal(writerFailure?.code,'MANAGED_SERVICE_REQUIRED');
   const denied=await run.request('native.package.publish',{});assert.equal(denied.status,404);assert.equal(denied.body.error.code,'UNKNOWN_OPERATION');
   assert.deepEqual(await httpRead('project.inspect'),project.result);assert.deepEqual(await httpRead('run.list'),runsBefore);
   const definitionAfter=await run.read('lifecycle.definition.inspect');assert.deepEqual(definitionAfter.active,definitionBefore.active);assert.deepEqual(definitionAfter.draft,definitionBefore.draft);
   assert.deepEqual(protectedReference(selected.ownerConfig),ownerConfig);assert.deepEqual(protectedReference(selected.fixture),fixture);assert.deepEqual(protectedReference(run.selection.legacyCompatibility),selected);
   for(const owner of ['ontology','harness'])assert.deepEqual(owners.verifyOwnerDistribution(owner,fixture.packageRoots[owner]),Object.fromEntries(Object.entries(versionMatrix.owners[owner]).filter(([key])=>key!=='releaseUrl')));
   const deactivated=await legacyCall('deactivate');assert.equal(deactivated.result.serviceStopped,false);assert.equal(deactivated.sessionActive,false);await host.close();host=null;
   assert.equal((await run.read('runtime.status')).serviceId,selected.serviceId);
   return{actualCodexHost:true,actualModelTurn:false,expertDialogueCompleted:false,samePluginHttpAndLegacy:true,modernToolsNotDuplicated:true,sameProjectGoalAndReceipt:true,legacyWrites:1,ownerNativeValidations:ownerResults,actualHistoricalOwnerCombination:true,versionMatrix,legacyNoticeObserved:true,noSecondRuntimeWriter:true,ownerPackageBytesUnchanged:true,ownerSemanticOrPublicationDecisions:0,businessRunsDispatched:0,projectLifecycleActivationChanged:false,parentCodeOrReleaseChanged:false,historicalDevelopmentReportsReused:false};
  });
 }finally{try{await host?.close();}finally{run.finish();}}
}
if(process.argv[1]&&collectorPathToFileURL(collectorResolve(process.argv[1])).href===import.meta.url)test('E15 actual installed legacy Host delegates to one HTTP Runtime and exact published owners',executeE15);

// Fixed source-audited branches; no fixture or provider action runs at registration.
const E15_CALLABLE_ROUTES=Object.freeze({"E15.journey":{"handler":"executeE15/journey"}});
export function registerE15CallableCases(catalog){
 const routes=E15_CALLABLE_ROUTES;
 return registerFixedScenario({scenario:'E15',phase:'PRE_RELEASE',catalog,routes,execute:executeE15});
}
