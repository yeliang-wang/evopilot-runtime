// Installed additive usage acceptance. Controlled source files exercise the
// shipped read-only adapter; they are never represented as actual Host work.
// UT19/UT23/UT24 and lifecycle completion/maintenance need separate live drivers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';

const repository=fileURLToPath(new URL('../../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const zero=()=>({input:0,output:0,total:0,cachedInput:0,cacheWriteInput:0,reasoningOutput:0});
const unknown=()=>Object.fromEntries(Object.keys(zero()).map(k=>[k,null]));
const metrics=(input,output,cachedInput=0,reasoningOutput=0)=>({input,output,total:input+output,cachedInput,cacheWriteInput:0,reasoningOutput});
const external=m=>Object.fromEntries(Object.entries({input_tokens:m.input,output_tokens:m.output,total_tokens:m.total,cached_input_tokens:m.cachedInput,cache_write_input_tokens:m.cacheWriteInput,reasoning_output_tokens:m.reasoningOutput}).filter(([,v])=>v!==null));
const exact=(value,keys)=>assert.deepEqual(Object.keys(value).sort(),keys.sort());

// Verify protected selection bytes before importing any installed helper.
function usageRegular(ref,max=16777216){
 assert(path.isAbsolute(ref)&&fs.realpathSync(ref)===ref);const before=fs.lstatSync(ref);assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=max);
 const unchanged=stat=>{for(const key of ['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'])assert.equal(stat[key],before[key],'Installed bytes changed during inspection');};
 const fd=fs.openSync(ref,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{unchanged(fs.fstatSync(fd));const bytes=Buffer.alloc(before.size+1);let length=0;while(length<bytes.length){const n=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!n)break;length+=n;}assert.equal(length,before.size);unchanged(fs.fstatSync(fd));unchanged(fs.lstatSync(ref));return bytes.subarray(0,length);}finally{fs.closeSync(fd);}
}
export function verifyUsageInstalledBytes(root,expected){
 assert(path.isAbsolute(root)&&fs.realpathSync(root)===root);assert(/^[a-f0-9]{64}$/.test(expected));
 const bytes=usageRegular(path.join(root,'distribution-manifest.json')),manifest=JSON.parse(bytes);
 assert.equal(sha(bytes),expected,'Usage candidate manifest differs from selection');exact(manifest,['schema','version','archiveDigest','files']);assert.equal(manifest.schema,'runtime-standalone-distribution/v1');assert.equal(manifest.version,'0.9.0');
 assert(manifest.files&&typeof manifest.files==='object'&&!Array.isArray(manifest.files));const files=Object.entries(manifest.files);assert(files.length>0&&files.length<=10000);
 for(const name of ['dist/compat/project/files.js','dist/server/security.js','dist/installation/service-control.js'])assert.equal(manifest.files[name]?.type,'file','Required installed helper is not pinned');
 const packageRoot=path.join(root,'package');let size=0;
 for(const [name,pin] of files){
  assert(!path.isAbsolute(name)&&!name.split('/').some(part=>!part||part==='.'||part==='..'));const file=path.join(packageRoot,name);
  if(pin.type==='symlink'){assert(fs.lstatSync(file).isSymbolicLink());assert.equal(fs.readlinkSync(file),pin.target);const target=path.resolve(path.dirname(file),pin.target);assert(target.startsWith(packageRoot+path.sep));assert.equal(manifest.files[path.relative(packageRoot,target)]?.type,'file');assert.equal(fs.realpathSync(file),target);continue;}
  assert.equal(pin.type,'file');const content=usageRegular(file);size+=content.length;assert(size<=268435456,'Installed usage inspection exceeds distribution size bound');assert.equal(content.length,pin.bytes);assert.equal(sha(content),pin.sha256,'Unverified installed usage helper: '+name);
 }
 return{bytes,manifest};
}

export async function collectUsageReplay({report,source,bind,append,waitFor}){
 const before=await report(),s=await source('replay');await bind(s);
 const at=Date.now(),events=[
  {cumulative:metrics(100,10),total:110,age:0},
  {cumulative:metrics(100,10),total:110,age:0},
  {cumulative:metrics(150,15),total:165,age:0},
  {cumulative:metrics(120,12),total:165,age:60000},
  {cumulative:metrics(200,20),total:220,age:0}
 ];
 let result;
 for(const [index,event] of events.entries()){
  append(s,event.cumulative,event.cumulative,true,new Date(at-event.age).toISOString());
  result=await waitFor(s,index+1);
  assert.equal((result.counts.total.recorded??0)-(before.counts.total.recorded??0),event.total,'Replay or late counters must not duplicate/subtract cumulative consumption');
  assert.equal(result.sources.find(v=>v.id===s.id)?.records,index+1,'All original observations remain visible');
 }
 assert.equal(result.counts.total.unknownRecords,before.counts.total.unknownRecords+1,'The delayed lower counter stays unknown rather than subtracting usage');
 assert(result.issues.some(v=>v.code==='RESET_OR_CORRECTION_total'));
 return{originalObservations:5,recordedTotal:220,replayedCumulativeAdded:0,lateLowerCounter:'UNKNOWN',historyRetained:true,syntheticSource:true};
}
/** The callable entry performs the same installed checks as direct execution.
 * Importing this module does not read a selection or start acceptance work. */
export async function executeUsageAcceptance(selectedRef=process.env.EVOPILOT_V090_USAGE_SELECTION){
 assert(selectedRef,'Select a protected isolated usage campaign explicitly');
 assert(path.isAbsolute(selectedRef)&&fs.realpathSync(selectedRef)===selectedRef);
 const stat=fs.lstatSync(selectedRef);assert(stat.isFile()&&stat.nlink===1&&stat.uid===process.getuid()&&(stat.mode&0o077)===0&&stat.size<=131072);
 const selection=JSON.parse(fs.readFileSync(selectedRef));
 exact(selection,['schema','installedRoot','expectedManifestDigest','sourceRevision','connectionRef','workspaceId','projectId','runId','outputRoot','qualification','caseIds','instanceId','targetVersion','principalRevision']);
 assert.equal(selection.schema,'runtime-v090-usage-selection/v1');
 assert(['DEVELOPMENT','FINAL_CANDIDATE'].includes(selection.qualification));
 assert(/^[a-z][a-z0-9-]{0,19}$/.test(selection.runId));
 assert(/^[a-f0-9]{64}$/.test(selection.expectedManifestDigest));
 assert(Number.isSafeInteger(selection.principalRevision)&&selection.principalRevision>0);
 assert(!process.execArgv.some(a=>/loader|--import|--require|^-r$/.test(a))&&!process.env.NODE_OPTIONS,'Usage installed execution forbids module substitution');
 const verifiedDistribution=verifyUsageInstalledBytes(selection.installedRoot,selection.expectedManifestDigest);
 const installedModule=name=>import(pathToFileURL(path.join(selection.installedRoot,'package/dist',name+'.js')).href);
 const {readRegular,canonicalPath}=await installedModule('compat/project/files');
 const {readHostConnection,hostHeaders}=await installedModule('server/security');
 const {inspectInstalledServiceSelection}=await installedModule('installation/service-control');
 const addendumBytes=fs.readFileSync(path.join(repository,'governance/token-usage-v090.json')),addendum=JSON.parse(addendumBytes),all=addendum.acceptance.cases.filter(c=>c.phase==='PRE_RELEASE');
 assert.equal(addendum.acceptance.originalRequiredInstances,664);assert.equal(all.length,23);assert.equal(addendum.acceptance.combinedRequiredInstances,688);
 const ids=selection.caseIds;assert(Array.isArray(ids)&&ids.length&&new Set(ids).size===ids.length&&ids.every(id=>all.some(c=>c.id===id)));
 const {bytes:manifestBytes,manifest}=verifiedDistribution;
 const plan=JSON.parse(fs.readFileSync(path.join(selection.installedRoot,'installation-plan.json'))),installed=inspectInstalledServiceSelection(selection.installedRoot),connection=readHostConnection(selection.connectionRef);
 assert.equal(sha(manifestBytes),selection.expectedManifestDigest);assert.equal(plan.distribution.manifestDigest,selection.expectedManifestDigest);
 assert.equal(manifest.version,'0.9.0');assert.equal(connection.serviceId,installed.serviceId);assert.equal(connection.workspaceId,selection.workspaceId);assert.equal(connection.projectId,selection.projectId);
 assert.equal(selection.connectionRef,path.join(selection.installedRoot,'connection.json'));
 exact(selection.sourceRevision,['ref','sha256']);const revision=readRegular(selection.sourceRevision.ref,128,true);assert.equal(sha(revision),selection.sourceRevision.sha256);
 const sourceCommit=revision.toString().trim();assert(/^[a-f0-9]{40}$/.test(sourceCommit));
 const execute=(binary,args)=>new Promise(resolve=>execFile(binary,args,{encoding:'utf8',timeout:30000,maxBuffer:1048576},(error,stdout,stderr)=>resolve({exitCode:error?.code??0,signal:error?.signal??null,stdout,stderr})));
 if(selection.qualification==='FINAL_CANDIDATE'){
  const head=await execute('/usr/bin/git',['-C',repository,'rev-parse','HEAD']),state=await execute('/usr/bin/git',['-C',repository,'status','--porcelain']);
  assert.equal(head.exitCode,0);assert.equal(head.stdout.trim(),sourceCommit);assert.equal(state.exitCode,0);assert.equal(state.stdout,'');
 }
 canonicalPath(path.dirname(selection.outputRoot));assert(!fs.existsSync(selection.outputRoot),'Preserve prior campaign evidence');assert(!selection.outputRoot.startsWith(selection.installedRoot+path.sep));
 fs.mkdirSync(selection.outputRoot,{mode:0o700});
 const save=(name,value)=>{const ref=path.join(selection.outputRoot,name);fs.writeFileSync(ref,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});return ref;};
 const candidate={manifestDigest:selection.expectedManifestDigest,archiveDigest:manifest.archiveDigest,version:manifest.version,serviceId:connection.serviceId,workspaceId:selection.workspaceId,projectId:selection.projectId},candidateDigest='sha256:'+selection.expectedManifestDigest;
 save('selection.json',{scenario:'UT',sourceCommit,qualification:selection.qualification,candidate,candidateDigest,addendumDigest:sha(addendumBytes),collectorPins:{'usage.test.mjs':sha(fs.readFileSync(fileURLToPath(import.meta.url)))},selectedCaseIds:ids,scenarioDenominator:23,fullDenominator:688});
 let serial=0,currentCase=null,uncertain=false;const evidence=[],results=[];
 const artifact=(name,value)=>{const leaf=String(++serial).padStart(5,'0')+'-'+name+'.json',ref=save(leaf,{caseInstanceId:currentCase,...value});evidence.push({caseInstanceId:currentCase,artifact:leaf,fileDigest:sha(fs.readFileSync(ref))});};
 async function request(operation,input={},write=false,projectId=selection.projectId){
  assert(!uncertain,'Inspect the retained uncertain original request; do not retry');
  let meta={};if(write){const status=await request('runtime.status');assert.equal(status.status,200);meta={requestId:selection.runId+'-'+(++serial),expectedRevision:status.body.result.revision};}
  const envelope={operation,projectId,input,...meta},id=String(++serial).padStart(5,'0'),requestRef=save(id+'-request.json',{caseInstanceId:currentCase,envelope});
  let response,raw;
  try{response=await fetch(connection.origin+'/api/v1/request',{method:'POST',headers:{...hostHeaders(connection),'content-type':'application/json'},body:JSON.stringify(envelope),redirect:'error',signal:AbortSignal.timeout(30000)});const reader=response.body.getReader(),parts=[];let size=0;try{for(;;){const v=await reader.read();if(v.done)break;size+=v.value.length;assert(size<=1048576);parts.push(v.value);}}finally{reader.releaseLock();}raw=Buffer.concat(parts).toString();}
  catch(error){uncertain=write;artifact('transport-failure',{operation,requestId:meta.requestId??null,outcome:write?'UNKNOWN':'READ_FAILED',error:String(error),automaticRetry:false});throw error;}
  const body=JSON.parse(raw),responseRef=save(id+'-response.json',{caseInstanceId:currentCase,status:response.status,rawBody:raw,body});
  evidence.push({caseInstanceId:currentCase,request:path.basename(requestRef),requestDigest:sha(fs.readFileSync(requestRef)),response:path.basename(responseRef),fileDigest:sha(fs.readFileSync(responseRef)),responseDigest:sha(raw)});
  return{status:response.status,body};
 }
 const read=async(op,input={})=>{const r=await request(op,input);assert.equal(r.status,200,JSON.stringify(r.body));assert(!r.body.error,JSON.stringify(r.body));return r.body.result;};
 const mutate=async(op,input)=>{const r=await request(op,input,true);assert.equal(r.status,200,JSON.stringify(r.body));assert(!r.body.error,JSON.stringify(r.body));return r.body.result.result;};
 async function cli(args,expected=0){const result=await execute(plan.nodeExecutable,[path.join(selection.installedRoot,'package/dist/server/cli.js'),...args]);artifact('installed-cli',{args,result});assert.equal(result.exitCode,expected,result.stdout+result.stderr);assert.equal(result.signal,null);return JSON.parse(result.stdout);}
 const instance=(await read('lifecycle.instance.inspect',{instanceId:selection.instanceId})).instance;
 assert.equal(instance.pins.projectId,selection.projectId);
 const initialInstance=structuredClone(instance),query={targetVersion:selection.targetVersion,instanceId:instance.id},report=()=>read('usage.report.read',query);
 const reportDelta=(before,after,key='total')=>(after.counts[key].recorded??0)-(before.counts[key].recorded??0);
 async function waitFor(source,count){const end=Date.now()+60000;let found;do{const r=await report();found=r.sources.find(s=>s.id===source.id);if(found?.records===count)return r;await new Promise(resolve=>setTimeout(resolve,500));}while(Date.now()<end);assert.fail('Installed worker did not collect expected original records for '+source.id);}
 function append(source,cumulative,last=cumulative,context=true,observedAt=new Date().toISOString()){
  const lines=[];if(context)lines.push({type:'turn_context',payload:{turn_id:'controlled-turn',model:'controlled-model'}});
  lines.push({type:'event_msg',timestamp:observedAt,payload:{type:'token_count',info:{total_token_usage:external(cumulative),last_token_usage:external(last)},rate_limits:{secret:'CONTROLLED_PRIVATE_RATE_LIMIT'}}});
  const offset=fs.statSync(source.path).size,bytes=lines.map(v=>JSON.stringify(v)+'\n').join('');
  fs.appendFileSync(source.path,bytes);artifact('controlled-original-source-events',{sourceId:source.id,offset,bytes,sha256:sha(bytes),syntheticSource:true});return fs.statSync(source.path).size;
 }
 async function source(suffix,{baseline=zero(),agentRole='main',parentThreadId=null,modelProvider='controlled-provider',epoch='one',predecessorId,sourcePath,initialOffset}={}){
  const id=selection.runId+'-'+currentCase.toLowerCase()+'-'+suffix,sourceFile=sourcePath??path.join(selection.outputRoot,id+'.jsonl');
  if(!sourcePath)fs.writeFileSync(sourceFile,JSON.stringify({type:'session_meta',payload:{id:'controlled-'+id,cli_version:'controlled-acceptance-format',model_provider:modelProvider,base_instructions:'CONTROLLED_PRIVATE_PROMPT'}})+'\n',{mode:0o600,flag:'wx'});
  const inspected=await cli(['usage-inspect','--source',sourceFile,...(initialOffset===undefined?[]:['--after-offset',String(initialOffset)])]);
  const grant={schema:'runtime-codex-usage-grant/v1',id,workspaceId:selection.workspaceId,projectId:selection.projectId,principalId:connection.principalId,principalRevision:selection.principalRevision,path:sourceFile,identity:inspected.source,epoch,agentRole,parentThreadId,baseline,baselineEvidence:'controlled:explicit-baseline',expiresAt:plan.credentialExpiresAt,...(predecessorId?{predecessorId}:{}),...(inspected.initialCursor?{initialCursor:inspected.initialCursor}:{})};
  const grantRef=save(id+'-grant.json',grant);await cli(['usage-grant','--state-root',path.join(selection.installedRoot,'data'),'--workspace-id',selection.workspaceId,'--grant-ref',grantRef]);await mutate('usage.source.register',{sourceId:id});
  return{id,path:sourceFile,grant};
 }
 const binding=(s,overrides={})=>({id:s.id+'-b',sourceId:s.id,afterSequence:0,throughSequence:null,targetVersion:selection.targetVersion,targetRef:instance.pins.targetRef,instanceId:instance.id,stageId:'implementation',baseStage:'implementation',taskId:currentCase,attemptId:'original',workType:'testing',...overrides});
 const bind=(s,overrides={})=>mutate('usage.attribution.bind',binding(s,overrides));
 const rejectBinding=async(s,overrides,code)=>{const r=await request('usage.attribution.bind',binding(s,overrides),true);assert.notEqual(r.status,200);assert.equal(r.body.error.code,code);};
 const implementations={
  UT03:()=>collectUsageReplay({report,source,bind,append,waitFor}),
  async UT01(){const before=await report(),s=await source('inclusive');await bind(s);append(s,metrics(100,20,80,10));const r=await waitFor(s,1);assert.equal(reportDelta(before,r),120);assert.equal(reportDelta(before,r,'cachedInput'),80);assert.equal(reportDelta(before,r,'reasoningOutput'),10);return{inclusiveTotal:120,cachedSubset:80,reasoningSubset:10};},
  async UT02(){const before=await report(),s=await source('unknown',{baseline:unknown()});await bind(s);append(s,unknown());const r=await waitFor(s,1);assert.equal(reportDelta(before,r),0);assert.equal(r.counts.total.unknownRecords,before.counts.total.unknownRecords+1);assert.equal(r.completeVersionTotal,false);assert.equal(r.coverage,'REGISTERED_SOURCES_ONLY');return{unknownPreserved:true,coverageLimited:true};},
  async UT04(){const before=await report(),s=await source('reset');await bind(s);append(s,metrics(100,10));await waitFor(s,1);append(s,metrics(20,2));let r=await waitFor(s,2);assert.equal(reportDelta(before,r),110);assert(r.issues.some(v=>v.code==='RESET_OR_CORRECTION_total'));await mutate('usage.source.revoke',{sourceId:s.id});const next=await source('epoch',{sourcePath:s.path,epoch:'two',predecessorId:s.id,initialOffset:fs.statSync(s.path).size});await bind(next,{attemptId:'declared-reset'});append(next,metrics(30,3));r=await waitFor(next,1);assert.equal(reportDelta(before,r),143);return{undeclaredResetUnknown:true,explicitNextEpoch:33,oldHistoryRetained:true};},
  async UT05(){const before=await report(),s=await source('fork',{baseline:metrics(1000,100,800,10),agentRole:'subagent',parentThreadId:'controlled-parent'});await bind(s);append(s,metrics(1100,120,880,15));const r=await waitFor(s,1);assert.equal(reportDelta(before,r),120);assert.equal(reportDelta(before,r,'cachedInput'),80);assert.equal(r.sources.find(v=>v.id===s.id).parentThreadId,'controlled-parent');const missing=await source('fork-unknown',{baseline:unknown(),agentRole:'subagent',parentThreadId:'controlled-parent'});await bind(missing);append(missing,metrics(1000,100),metrics(10,1));const x=await waitFor(missing,1);assert.equal(reportDelta(r,x),0);assert(x.issues.some(v=>v.code==='UNKNOWN_FORK_BASELINE_total'));return{inheritedExcluded:true,unknownFirstForkNotGuessed:true,sourceRoleRetained:true};},
  async UT06(){const s=await source('scope');await rejectBinding(s,{instanceId:'missing-instance'},'NOT_FOUND');await rejectBinding(s,{targetRef:'controlled:wrong-target'},'USAGE_ATTRIBUTION_SCOPE');await bind(s,{throughSequence:100000});await rejectBinding(s,{id:s.id+'-overlap',afterSequence:1,taskId:'parallel'},'USAGE_RANGE_OVERLAP');const wrong=await request('usage.report.read',query,false,'ungranted-project');assert.equal(wrong.status,403);return{instanceTargetProjectScopeEnforced:true,overlappingTaskRejected:true};},
  async UT09(){const before=await report(),s=await source('tasks');await bind(s);const boundary=append(s,metrics(100,10));await waitFor(s,1);await mutate('usage.attribution.close',{bindingId:s.id+'-b',throughSequence:boundary});await bind(s,{id:s.id+'-next',afterSequence:boundary,stageId:'verification',baseStage:'verification',taskId:'parallel-task',attemptId:'repair'});append(s,metrics(150,15));const r=await waitFor(s,2);assert.equal(reportDelta(before,r),165);assert(r.views.task.some(v=>v.key==='parallel-task/repair'&&v.counts.total.recorded===55));assert.deepEqual((await read('lifecycle.instance.inspect',{instanceId:instance.id})).instance,initialInstance);return{explicitRanges:true,wallClockAndCurrentStageNotUsed:true,instanceUnchanged:true};},
  async UT10(){const node=instance.definition.nodes.find(n=>n.id.startsWith('project.'));assert(node,'Select an instance with an actual project extension for UT10');const s=await source('extension');await rejectBinding(s,{baseStage:'scope'},'USAGE_BASE_STAGE');await bind(s,{stageId:node.id,baseStage:'plan',throughSequence:100000});await rejectBinding(s,{id:s.id+'-changed',afterSequence:100000,stageId:node.id,baseStage:'candidate'},'USAGE_BASE_STAGE');append(s,metrics(10,2));const r=await waitFor(s,1);assert(r.views.node.some(v=>v.key===node.id));assert.deepEqual((await read('lifecycle.instance.inspect',{instanceId:instance.id})).instance,initialInstance);return{extension:node.id,explicitBaseMapping:true,baseUnchanged:true};},
  async UT11(){const s=await source('cutoff');await bind(s);append(s,metrics(10,1));await waitFor(s,1);const id=(await mutate('usage.snapshot.create',query)).id,frozen=await read('usage.snapshot.read',{id});append(s,metrics(20,2));const current=await waitFor(s,2);assert.equal(reportDelta(frozen.report,current),11);assert.deepEqual(await read('usage.snapshot.read',{id}),frozen);const next=(await mutate('usage.snapshot.create',query)).id;assert.notEqual(next,id);return{originalSnapshotImmutable:true,newRevisionRetainsOriginal:true,aggregateFromLedger:true};},
  async UT12(){assert.equal(instance.stages.implementation.status,'RUNNING','Select an actually active stage for UT12');const s=await source('in-progress');await bind(s);append(s,metrics(10,2));const r=await waitFor(s,1),markdown=await read('usage.report.read',{...query,format:'markdown'});assert.equal(r.completeVersionTotal,false);assert.deepEqual(markdown.report.counts,r.counts);assert.match(markdown.markdown,/已记录消耗/);return{actualStageStatus:'RUNNING',nativeOnDemand:true};},
  async UT17(){const s=await source('views');await bind(s);const boundary=append(s,metrics(10,2));await waitFor(s,1);await mutate('usage.attribution.close',{bindingId:s.id+'-b',throughSequence:boundary});const before=await report();append(s,metrics(15,3));let r;const deadline=Date.now()+60000;do{r=await report();if(r.unclassified.records>before.unclassified.records)break;await new Promise(resolve=>setTimeout(resolve,150));}while(Date.now()<deadline);assert.equal(r.unclassified.records,before.unclassified.records+1);assert.equal((r.unclassified.counts.total.recorded??0)-(before.unclassified.counts.total.recorded??0),6);for(const rows of Object.values(r.views))assert.equal(rows.reduce((sum,row)=>sum+(row.counts.total.recorded??0),0),r.counts.total.recorded);return{unclassifiedVisible:true,everyViewSameLedger:true,crossViewTotalsNotAdded:true};},
  async UT18(){const before=await report(),s=await source('provenance',{modelProvider:null,agentRole:'unknown'});await bind(s);append(s,metrics(10,1),metrics(10,1),false);const r=await waitFor(s,1);assert.equal(reportDelta(before,r),11);assert(r.views.model.some(v=>v.key==='unknown/unknown'));assert.equal(r.sources.find(v=>v.id===s.id).agentRole,'unknown');return{unavailableModelProviderUnknown:true,sourceThreadAndRoleRetained:true};},
  async UT20(){const s=await source('privacy');await bind(s);append(s,metrics(10,1));const r=await waitFor(s,1);assert(!JSON.stringify(r).includes('CONTROLLED_PRIVATE'));const link=path.join(selection.outputRoot,s.id+'-link.jsonl');fs.symlinkSync(s.path,link);const linked=await execute(plan.nodeExecutable,[path.join(selection.installedRoot,'package/dist/server/cli.js'),'usage-inspect','--source',link]);artifact('rejected-symlink',{result:linked});assert.notEqual(linked.exitCode,0);assert(!linked.stdout.includes('CONTROLLED_PRIVATE'));const secret=path.join(selection.outputRoot,s.id+'-credential.jsonl');fs.writeFileSync(secret,'{"token":"CONTROLLED_SECRET"}\n',{mode:0o600});const denied=await execute(plan.nodeExecutable,[path.join(selection.installedRoot,'package/dist/server/cli.js'),'usage-inspect','--source',secret]);artifact('rejected-noncodex-source',{result:denied});assert.notEqual(denied.exitCode,0);assert(!denied.stdout.includes('CONTROLLED_SECRET'));const remote=await request('usage.source.register',{sourceId:s.id+'-remote',path:s.path},true);assert.notEqual(remote.status,200);return{readOnlyExplicitSource:true,promptAndCredentialNotDisclosed:true,symlinkRejected:true,remotePathRejected:true};},
  async UT21(){const s=await source('revoke');await bind(s);append(s,metrics(10,1));const before=await waitFor(s,1);await mutate('usage.source.revoke',{sourceId:s.id});append(s,metrics(30,3));const sources=await read('usage.sources.list');const observationMs=(sources.sources.length+2)*1100;assert(observationMs<=60000);await new Promise(resolve=>setTimeout(resolve,observationMs));artifact('revocation-observation-window',{observationMs,sources:sources.sources.length});const after=await report();assert.equal(reportDelta(before,after),0);assert.equal(after.sources.find(v=>v.id===s.id).revoked,true);const denied=await request('usage.report.read',query,false,'ungranted-project');assert.equal(denied.status,403);assert.deepEqual((await read('lifecycle.instance.inspect',{instanceId:instance.id})).instance,initialInstance);return{revocationStopsCollection:true,projectScopeEnforced:true,businessStateUnchanged:true};}
 };
 artifact('installed-selection',{candidate,sourceCommit,controlledSourceFixtures:true,actualCodexHost:false,instancePins:instance.pins,initialStageStates:instance.stages,productAcceptance:'NOT_EVALUATED'});
 try{
  for(const id of ids){
   if(!implementations[id])continue;
   currentCase=id;let result;
   try{const assertions=await implementations[id]();result={caseInstanceId:id,status:'PASS',qualification:selection.qualification,candidateDigest,assertions,evidence:evidence.filter(e=>e.caseInstanceId===id)};}
   catch(error){result={caseInstanceId:id,status:'FAIL',qualification:selection.qualification,candidateDigest,assertions:{error:String(error)},evidence:evidence.filter(e=>e.caseInstanceId===id)};}
   results.push(result);save(id+'.json',result);if(result.status==='FAIL')break;
  }
 }finally{
  const passed=results.filter(r=>r.status==='PASS').length,failed=results.length-passed,unexecutedCaseIds=all.map(c=>c.id).filter(id=>!results.some(r=>r.caseInstanceId===id));
  save('report.json',{schema:'runtime-usage-acceptance-report/v1',scenario:'UT',sourceCommit,qualification:selection.qualification,candidate,candidateDigest,selectionDigest:sha(fs.readFileSync(path.join(selection.outputRoot,'selection.json'))),fullDenominator:688,scenarioDenominator:23,selected:ids.length,executed:results.length,passed,failed,unexecutedCaseIds,scenarioStatus:failed?'FAILED':unexecutedCaseIds.length?'INCOMPLETE':'OBSERVED_PASS',results,setupEvidence:evidence.filter(e=>e.caseInstanceId===null),original664IndependentlyRequired:true,productAcceptance:'NOT_EVALUATED',releaseAuthorized:false});
 }
 assert.equal(results.filter(r=>r.status==='FAIL').length,0,'A selected case failed; retain evidence and inspect before retry');
 assert.equal(results.length,ids.length,'Selected cases lack their required live driver; no skip or passing credit');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)test('fixed installed token-usage cases retain independent candidate-bound evidence',()=>executeUsageAcceptance());
