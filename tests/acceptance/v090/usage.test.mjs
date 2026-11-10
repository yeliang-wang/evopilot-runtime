// Installed additive usage acceptance. Controlled source files exercise the
// shipped read-only adapter; they are never represented as actual Host work.
// Native completion/retry drivers read reviewed originals; they never dispatch
// business work. UT19/UT23/UT24 and maintenance need separate live drivers.
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
const exact=(value,keys,optional=[])=>{assert(keys.every(k=>Object.hasOwn(value,k)));assert(Object.keys(value).every(k=>keys.includes(k)||optional.includes(k)));};
const baseStages=['scope','plan','implementation','candidate','verification','release-decision','publication','closure'];
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
const nativeDigest=v=>'sha256:'+sha(canonical(v));

/** Reviewed originals are prerequisites, never fresh execution authority.
 * read and collectSource are wired to the exact installed service and adapter.
 * SOURCE tests can inject synthetic native shapes without claiming live credit. */
export async function collectUsageNative({caseId,selection,proof,read,collectSource,artifact,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
 assert(['UT08','UT13','UT14','UT15'].includes(caseId));
 exact(proof,['schema','candidateDigest','workspaceId','projectId','targetVersion','completionInstanceId','deadlineAt','maxRequests','stages','sources']);
 assert.equal(proof.schema,'runtime-usage-native-originals/v1');
 for(const k of ['workspaceId','projectId','targetVersion'])assert.equal(proof[k],selection[k]);
 assert.equal(proof.candidateDigest,'sha256:'+selection.expectedManifestDigest);
 assert(typeof proof.completionInstanceId==='string'&&/^[a-z0-9][a-z0-9-]*$/.test(proof.completionInstanceId));
 assert(Number.isSafeInteger(proof.maxRequests)&&proof.maxRequests>=1&&proof.maxRequests<=600);
 const started=now(),end=Math.min(started+120000,Date.parse(proof.deadlineAt));let calls=0;
 const guard=()=>assert(Number.isFinite(end)&&now()<end,'NOT_READY: original native usage observation deadline exhausted');
 const get=async(op,input={})=>{guard();assert(++calls<=proof.maxRequests,'NOT_READY: original native usage request budget exhausted');const value=await read(op,input,Math.max(1,Math.min(30000,end-now())));guard();return value;};
 const pages=async(op,key)=>{const rows=[];let after;for(let page=0;page<64;page++){const v=await get(op,after?{after}:{});assert(Array.isArray(v[key])&&v[key].length<=50);rows.push(...v[key]);if(v.nextAfter===null)return rows;assert(typeof v.nextAfter==='string'&&v.nextAfter!==after);after=v.nextAfter;}assert.fail('NOT_READY: native usage inventory exceeds bounded profile');};
 const events=async()=>{const rows=[];let cursor;for(let page=0;page<64;page++){const v=await get('runtime.events.read',cursor?{cursor}:{});assert(Array.isArray(v.events)&&v.events.length<=50);for(const e of v.events){assert(e.seq>(rows.at(-1)?.seq??0));rows.push(e);}if(!v.events.length)return rows;assert(typeof v.cursor==='string'&&v.cursor!==cursor);cursor=v.cursor;}assert.fail('NOT_READY: native event inventory exceeds bounded profile');};
 guard();assert(Array.isArray(proof.stages)&&proof.stages.length>0&&proof.stages.length<=32);assert(Array.isArray(proof.sources)&&proof.sources.length>0&&proof.sources.length<=32);
 const originalEvents=await events(),instances=new Map(),stages=new Map();
 for(const original of proof.stages){
  exact(original,['request','observation','event','admission'],['nativeEvidence']);
  const r=original.request,{digest,...body}=r;assert.equal(digest,nativeDigest(body));assert.equal(r.schema,'runtime-stage-request/v1');assert.equal(r.planDigest,nativeDigest(r.plan));
  assert.equal(r.workspaceId,selection.workspaceId);assert.equal(r.projectId,selection.projectId);assert(!stages.has(r.id));
  const stage=await get('lifecycle.stage.request.inspect',{stageRequestId:r.id});assert.deepEqual(stage.request,r);assert.equal(stage.automaticRedispatch,false);assert.equal(stage.progress.terminal,true);assert(['COMPLETE','FAILED'].includes(stage.progress.phase));
  const observation=await get('lifecycle.stage.observation.read',{stageRequestId:r.id,observationRef:original.observation.observationRef});assert.deepEqual(observation,original.observation);assert.equal(observation.observationRef,nativeDigest(observation.evidence));assert.equal(observation.historical,true);assert.equal(observation.evidence.requestId,r.id);assert.deepEqual(stage.progress.observation,observation.evidence.observation);assert.equal(stage.progress.observationRef,observation.observationRef);
  const o=observation.evidence.observation;assert.equal(o.requestId,r.id);assert.equal(o.inputDigest,r.inputDigest);assert.equal(o.adapterDigest,r.plan.adapterDigest);assert.equal(o.phase,stage.progress.phase);assert.equal(o.outcome.status,o.phase);assert.equal(o.outcome.requestId,r.id);assert.equal(o.outcome.inputDigest,r.inputDigest);assert(o.outcome.receiptRef);
  const e=original.event;assert.equal(e.type,'stage-observed');for(const [k,v]of Object.entries({instanceId:r.instanceId,stageId:r.stageId,stageRequestId:r.id,phase:o.phase,observationRef:observation.observationRef}))assert.equal(e.data[k],v);assert(Number.isSafeInteger(e.revision)&&e.revision>0);assert(Number.isFinite(Date.parse(e.at)));assert.deepEqual(originalEvents.find(v=>v.seq===e.seq),e);
  const receipt=await get('runtime.receipt.read',{requestId:original.admission.requestId});assert.deepEqual(receipt,original.admission);assert.equal(receipt.operation,'lifecycle.stage.request');assert.equal(receipt.result.stageRequestId,r.id);assert.equal(receipt.principalId,r.initiatedBy.id);
  if(!instances.has(r.instanceId)){const v=await get('lifecycle.instance.inspect',{instanceId:r.instanceId});instances.set(r.instanceId,{instance:v.instance,loopBudget:v.loopBudget??null});}
  const inst=instances.get(r.instanceId).instance;assert.equal(inst.pins.projectId,selection.projectId);assert.equal(inst.pinsDigest,r.pinsDigest);assert(inst.requestIds.includes(r.id));
  if(o.phase==='COMPLETE'){assert.equal(inst.stages[r.stageId].status,'PASSED');assert.equal(inst.stages[r.stageId].requestId,r.id);}
  stages.set(r.id,{original,phase:o.phase});
 }
 const sources=await pages('usage.sources.list','sources'),bindings=await pages('usage.attributions.list','bindings'),rows=[],selectedSourceIds=new Set();
 for(const original of proof.sources){
  exact(original,['sourceId','grant','observations','bindings','expectedDeltas','sourceKind']);assert(['CONTROLLED','ACTUAL_CODEX'].includes(original.sourceKind));assert(!selectedSourceIds.has(original.sourceId));selectedSourceIds.add(original.sourceId);
  const captured=await collectSource(original,guard);guard();artifact('native-source-readback',{sourceId:original.sourceId,sourceKind:original.sourceKind,...captured});
  const g=captured.grant,s=sources.find(s=>s.id===original.sourceId);assert(s,'NOT_READY: original registered source missing');assert.equal(g.id,s.id);assert.equal(g.projectId,selection.projectId);assert.equal(g.workspaceId,selection.workspaceId);assert.equal(s.grantDigest,sha(canonical(g)));assert.equal(s.threadId,g.identity.threadId);assert.equal(s.epoch,g.epoch);assert.deepEqual(s.baseline,g.baseline);assert.equal(s.parentThreadId,g.parentThreadId);assert.equal(s.agentRole,g.agentRole);assert.equal(s.principalId,g.principalId);assert.equal(s.principalRevision,g.principalRevision);
  assert.equal(captured.caughtUp,true);assert.deepEqual(captured.observations,original.observations);assert.deepEqual(s.cursor,{offset:captured.cursor.offset,latestSequence:captured.cursor.latestSequence});assert.equal(s.health?.status,'CAUGHT_UP');
  assert(Array.isArray(original.observations)&&original.observations.length>0&&original.observations.length<=256);assert.equal(original.expectedDeltas.length,original.observations.length);assert(Array.isArray(original.bindings)&&original.bindings.length>0);
  for(const b of original.bindings){assert.deepEqual(bindings.find(v=>v.binding.id===b.binding.id),b);assert.equal(b.binding.sourceId,s.id);assert.equal(b.binding.projectId,selection.projectId);const stage=stages.get(b.binding.attemptId);assert(stage,'NOT_READY: each consumption attempt needs its native original');const r=stage.original.request;assert.equal(b.binding.instanceId,r.instanceId);assert.equal(b.binding.instancePinsDigest,r.pinsDigest);assert.equal(b.binding.stageId,r.stageId);assert.equal(b.binding.targetRef,instances.get(r.instanceId).instance.pins.targetRef);assert(baseStages.includes(b.binding.baseStage));if(baseStages.includes(r.stageId))assert.equal(b.binding.baseStage,r.stageId);}
  assert.deepEqual(bindings.filter(v=>v.binding.sourceId===s.id),original.bindings,'NOT_READY: complete original source attribution inventory required');
  // Require monotonic original counters; missing metrics remain null. Replay
  // and reset behavior have separate UT cases. Never manufacture a missing zero.
  let prior={...g.baseline},sequence=0;
  for(const [index,o]of original.observations.entries()){
   assert(Number.isSafeInteger(o.sequence)&&o.sequence>sequence);sequence=o.sequence;assert(Number.isFinite(Date.parse(o.observedAt)));const d=original.expectedDeltas[index];exact(d,['sequence','counts']);assert.equal(d.sequence,o.sequence);exact(d.counts,Object.keys(zero()));
   for(const key of Object.keys(zero())){const current=o.cumulative[key];if(current===null){assert.equal(d.counts[key],null);continue;}assert(Number.isSafeInteger(current)&&current>=0);if(prior[key]===null)assert.equal(d.counts[key],g.parentThreadId===null?o.last[key]:null);else{assert(Number.isSafeInteger(prior[key])&&prior[key]>=0&&current>=prior[key]);assert.equal(d.counts[key],current-prior[key]);}prior[key]=current;}assert(Number.isSafeInteger(d.counts.total)&&d.counts.total>=0,'NOT_READY: original attempt requires a recorded inclusive count');assert.equal(d.counts.total,d.counts.input+d.counts.output);for(const [subset,parent]of [['cachedInput','input'],['cacheWriteInput','input'],['reasoningOutput','output']])if(d.counts[subset]!==null&&d.counts[parent]!==null)assert(d.counts[subset]<=d.counts[parent]);
   const matches=original.bindings.filter(({binding:b,closure:c})=>o.sequence>b.afterSequence&&((c?.throughSequence??b.throughSequence)===null||o.sequence<=(c?.throughSequence??b.throughSequence)));assert.equal(matches.length,1,'NOT_READY: each reviewed count needs one exact native attribution');rows.push({source:s,observation:o,binding:matches[0].binding,counts:d.counts});
  }
 }
 const expected=(version,throughTime=null)=>rows.filter(r=>r.binding.targetVersion===version&&(throughTime===null||Date.parse(r.observation.observedAt)<=Date.parse(throughTime)));
 const sum=items=>Object.fromEntries(Object.keys(zero()).map(k=>{const known=items.filter(r=>r.counts[k]!==null);return[k,{recorded:known.length?known.reduce((n,r)=>n+r.counts[k],0):null,unknownRecords:items.length-known.length}];}));
 const assertReport=(r,version,time=null)=>{const selected=expected(version,time);assert.equal(r.schema,'runtime-token-report/v1');assert.equal(r.projectId,selection.projectId);assert.equal(r.targetVersion,version);assert.equal(r.instanceId,null);assert.equal(r.stageId,null);assert.equal(r.throughTime,time);assert.equal(r.completeVersionTotal,false);assert.equal(r.coverage,'REGISTERED_SOURCES_ONLY');assert.equal(r.records,selected.length);assert.deepEqual(r.counts,sum(selected));assert.deepEqual(r.truncatedViews,[]);const {digest,...body}=r;assert.equal(digest,sha(canonical(body)));
  for(const [view,key]of Object.entries({stage:x=>x.binding.baseStage,node:x=>x.binding.stageId,target:x=>x.binding.targetRef,task:x=>x.binding.taskId+'/'+x.binding.attemptId,workType:x=>x.binding.workType,model:x=>(x.observation.provider??'unknown')+'/'+(x.observation.model??'unknown'),agent:x=>x.source.agentRole+'/'+x.source.threadId,instance:x=>x.binding.instanceId})){const groups=new Map();for(const x of selected){const k=key(x);groups.set(k,[...(groups.get(k)??[]),x]);}const want=[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([key,items])=>({key,records:items.length,counts:sum(items),shareOfRecordedTotal:r.counts.total.recorded>0?sum(items).total.recorded/r.counts.total.recorded:null}));assert.deepEqual(r.views[view],want);}
  return selected;
 };
 const versionReport=await get('usage.report.read',{targetVersion:selection.targetVersion});assertReport(versionReport,selection.targetVersion);
 let observedSnapshots=[];
 if(caseId==='UT08'){
  const consumed=new Map();for(const row of expected(selection.targetVersion))consumed.set(row.binding.attemptId,(consumed.get(row.binding.attemptId)??0)+row.counts.total);
  const actual=[...stages.values()].filter(s=>(consumed.get(s.original.request.id)??0)>0);assert(new Set(actual.map(s=>s.original.request.instanceId)).size>=2,'NOT_READY: two actual consumed instances required');
  assert(actual.some(f=>f.phase==='FAILED'&&actual.some(r=>r.phase==='COMPLETE'&&r.original.request.instanceId===f.original.request.instanceId&&r.original.request.stageId===f.original.request.stageId&&Date.parse(r.original.request.requestedAt)>Date.parse(f.original.request.requestedAt))),'NOT_READY: original failed attempt and completed retry consumption required');assert(actual.some(s=>s.original.request.correctionRef),'NOT_READY: actual repair request consumption required');
 }else{
  const required=caseId==='UT13'?baseStages:caseId==='UT14'?['publication']:['publication','closure'],completed=required.map(stageId=>{const found=[...stages.values()].filter(s=>s.phase==='COMPLETE'&&s.original.request.instanceId===proof.completionInstanceId&&s.original.request.stageId===stageId);assert.equal(found.length,1,'NOT_READY: exact actual '+stageId+' completion required');assert(expected(selection.targetVersion).some(row=>row.binding.instanceId===proof.completionInstanceId),'NOT_READY: completed instance must belong to the selected version ledger');return found[0];});
  const inventory=await pages('usage.snapshots.list','snapshots');assert.equal(new Set(inventory.map(s=>s.id)).size,inventory.length);
  for(const stage of completed){const {request:r,event:e}=stage.original,trigger={instanceId:r.instanceId,stageId:r.stageId,stageRequestId:r.id,eventRevision:e.revision,completedAt:e.at},matches=inventory.filter(s=>canonical(s.trigger)===canonical(trigger)&&s.targetVersion===selection.targetVersion);assert(matches.length,'NOT_READY: native completion snapshot missing');const latest=matches.sort((a,b)=>b.cutoffRevision-a.cutoffRevision)[0];
   const snapshot=await get('usage.snapshot.read',{id:latest.id});assert.equal(snapshot.id,latest.id);assert.equal(snapshot.schema,'runtime-usage-snapshot/v1');assert.deepEqual(snapshot.trigger,trigger);assert.equal(snapshot.kind,r.stageId==='publication'?'publication':r.stageId==='closure'?'closure':'stage');assert.equal(latest.reportDigest,snapshot.report.digest);assert.equal(latest.cutoffRevision,snapshot.report.cutoffRevision);assert(snapshot.report.cutoffRevision>=e.revision);assertReport(snapshot.report,selection.targetVersion,e.at);observedSnapshots.push(snapshot);
   if(['publication','closure'].includes(r.stageId)){assert(stage.original.nativeEvidence,'NOT_READY: native '+r.stageId+' evidence original required');const v=await get('lifecycle.'+r.stageId+'.evidence.read',{stageRequestId:r.id});assert.deepEqual(v,stage.original.nativeEvidence);assert.equal(v.automaticRedispatch,false);assert.equal(v.historical,true);assert(v.evidence&&v.evidenceRef);assert.equal(v.evidenceRef,nativeDigest(v.evidence));assert.equal(v.evidence.requestDigest,r.digest);assert.equal(v.evidence.planDigest,r.planDigest);assert(r.stageId!=='publication'||r.releaseAuthorityRef);}
  }
  if(caseId==='UT15'){
   const [publication,closure]=observedSnapshots,closureAt=Date.parse(closure.trigger.completedAt);assert(closureAt>Date.parse(publication.trigger.completedAt));
   const subsequent=expected(selection.targetVersion,closure.trigger.completedAt).filter(r=>Date.parse(r.observation.observedAt)>Date.parse(publication.trigger.completedAt));assert(subsequent.some(r=>r.binding.baseStage==='closure'&&r.counts.total>0),'NOT_READY: actual post-publication closure work required');assert.equal(closure.report.counts.total.recorded-publication.report.counts.total.recorded,subsequent.reduce((n,r)=>n+r.counts.total,0));
   const foreign=rows.filter(r=>r.binding.targetVersion!==selection.targetVersion&&r.counts.total>0);assert(foreign.length,'NOT_READY: separately bound other-version consumption required');
   // This positive control needs actual work and its original usage observation
   // after closure. Ownership still comes from the verified native binding:
   // requests may span closure, and Host usage may arrive after stage completion.
   const laterWork=foreign.filter(r=>Date.parse(r.observation.observedAt)>closureAt&&Date.parse(stages.get(r.binding.attemptId).original.event.at)>closureAt);
   assert(laterWork.length,'NOT_READY: original other-version work and usage must be observed after closure');
   artifact('post-closure-other-version-usage',{closureCutoff:closure.trigger.completedAt,observations:laterWork.map(r=>{const original=stages.get(r.binding.attemptId).original;return{sourceId:r.source.id,sequence:r.observation.sequence,targetVersion:r.binding.targetVersion,targetRef:r.binding.targetRef,stageRequestId:original.request.id,requestedAt:original.request.requestedAt,workObservedAt:original.event.at,usageObservedAt:r.observation.observedAt,recordedTotal:r.counts.total};})});
   for(const version of new Set(foreign.map(r=>r.binding.targetVersion)))assertReport(await get('usage.report.read',{targetVersion:version}),version);
  }
  guard();await pause(Math.min(1100,end-now()));guard();
  for(const snapshot of observedSnapshots)assert.deepEqual(await get('usage.snapshot.read',{id:snapshot.id}),snapshot,'Original report revision was changed');
  assert.deepEqual(await pages('usage.snapshots.list','snapshots'),inventory,'NOT_READY: snapshot inventory not stable at the selected ledger cutoff');
 }
 assertReport(await get('usage.report.read',{targetVersion:selection.targetVersion}),selection.targetVersion);
 for(const [id,before]of instances){const after=await get('lifecycle.instance.inspect',{instanceId:id});assert.deepEqual({instance:after.instance,loopBudget:after.loopBudget??null},before,'Usage reporting changed business state, attempts or budget');}
 const finalEvents=await events();assert.deepEqual(finalEvents.filter(e=>!e.type.startsWith('usage-')),originalEvents.filter(e=>!e.type.startsWith('usage-')),'Usage observation created or changed business events');
 artifact('native-usage-proof',{caseId,calls,startedAt:new Date(started).toISOString(),deadlineAt:new Date(end).toISOString(),snapshots:observedSnapshots.map(s=>({id:s.id,trigger:s.trigger,digest:s.report.digest})),actualBusinessOriginals:true,sourceKinds:proof.sources.map(s=>s.sourceKind),newBusinessDispatches:0});
 return{actualBusinessOriginals:true,installedNativeReadback:true,observedSnapshots:observedSnapshots.length,sourceKinds:[...new Set(proof.sources.map(s=>s.sourceKind))],actualCodexHostAcceptance:false,businessStateAndBudgetsUnchanged:true,newBusinessDispatches:0,formalCaseCredit:0};
}

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
 exact(selection,['schema','installedRoot','expectedManifestDigest','sourceRevision','connectionRef','workspaceId','projectId','runId','outputRoot','qualification','caseIds','instanceId','targetVersion','principalRevision'],['nativeEvidence']);
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
 async function request(operation,input={},write=false,projectId=selection.projectId,timeoutMs=30000){
  assert(!uncertain,'Inspect the retained uncertain original request; do not retry');
  let meta={};if(write){const status=await request('runtime.status');assert.equal(status.status,200);meta={requestId:selection.runId+'-'+(++serial),expectedRevision:status.body.result.revision};}
  const envelope={operation,projectId,input,...meta},id=String(++serial).padStart(5,'0'),requestRef=save(id+'-request.json',{caseInstanceId:currentCase,envelope});
  let response,raw;
  try{response=await fetch(connection.origin+'/api/v1/request',{method:'POST',headers:{...hostHeaders(connection),'content-type':'application/json'},body:JSON.stringify(envelope),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});const reader=response.body.getReader(),parts=[];let size=0;try{for(;;){const v=await reader.read();if(v.done)break;size+=v.value.length;assert(size<=1048576);parts.push(v.value);}}finally{reader.releaseLock();}raw=Buffer.concat(parts).toString();}
  catch(error){uncertain=write;artifact('transport-failure',{operation,requestId:meta.requestId??null,outcome:write?'UNKNOWN':'READ_FAILED',error:String(error),automaticRetry:false});throw error;}
  const body=JSON.parse(raw),responseRef=save(id+'-response.json',{caseInstanceId:currentCase,status:response.status,rawBody:raw,body});
  evidence.push({caseInstanceId:currentCase,request:path.basename(requestRef),requestDigest:sha(fs.readFileSync(requestRef)),response:path.basename(responseRef),fileDigest:sha(fs.readFileSync(responseRef)),responseDigest:sha(raw)});
  return{status:response.status,body};
 }
 const read=async(op,input={},timeoutMs=30000)=>{const r=await request(op,input,false,selection.projectId,timeoutMs);assert.equal(r.status,200,JSON.stringify(r.body));assert(!r.body.error,JSON.stringify(r.body));return r.body.result;};
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
 const loadNativePin=pin=>{exact(pin,['ref','sha256']);assert(/^[a-f0-9]{64}$/.test(pin.sha256));const bytes=readRegular(pin.ref,4194304,true);assert.equal(sha(bytes),pin.sha256);return JSON.parse(bytes);};
 async function native(caseId){
  const pin=selection.nativeEvidence?.[caseId];assert(pin,'NOT_READY: reviewed native original pin required for '+caseId);const proof=loadNativePin(pin);artifact('reviewed-native-originals',{pin,proof});
  const {collectCodexUsage,validateUsageGrant}=await installedModule('usage/codex');
  const result=await collectUsageNative({caseId,selection,proof,read,artifact,collectSource:async(original,guard)=>{
   const grant=validateUsageGrant(loadNativePin(original.grant));assert.equal(original.grant.ref,path.join(selection.installedRoot,'data/usage-grants',original.sourceId+'.json'));
   // The native reader checks identity/permissions and returns only usage data.
   // Neither the raw rollout nor its prompts enter acceptance artifacts.
   const before=fs.statSync(grant.path);assert(before.size<=67108864,'NOT_READY: selected source exceeds the bounded native proof profile');let cursor=grant.initialCursor??null,observations=[],captured;
   for(let batch=0;batch<32;batch++){guard();captured=collectCodexUsage(grant.path,grant.identity,cursor);observations.push(...captured.observations);assert(observations.length<=256);cursor=captured.cursor;if(captured.caughtUp)break;}
   const after=fs.statSync(grant.path);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.ctimeMs,before.ctimeMs);assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);assert.equal(captured.caughtUp,true,'NOT_READY: native source not caught up within original budget');
   return{grant,observations,cursor,caughtUp:captured.caughtUp};
  }});
  assert.deepEqual(loadNativePin(pin),proof);return result;
 }
 const implementations={
  UT08:()=>native('UT08'),UT13:()=>native('UT13'),UT14:()=>native('UT14'),UT15:()=>native('UT15'),
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
