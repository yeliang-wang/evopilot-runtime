import {registerFixedScenario} from './preflight.mjs';
import {pathToFileURL as collectorPathToFileURL} from 'node:url';
import {resolve as collectorResolve} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium,expect} from '@playwright/test';
import {collectCaseCampaign,caseCampaignTestOptions,openScenario,sha} from './support.mjs';
import {openBrowser} from './browser.mjs';
import {LIFECYCLE_READBACK_CASES,collectLifecycleReadback,collectCoverageInventory,collectStageAdmission,collectManagedBudget} from './execution.mjs';

// E01 journey and independently collected non-RC/feedback readbacks.
// Remaining fixed instances keep their own unmet contracts.
// Native service requests own all dispatch. Direct installed GitHub-adapter
// calls below are read-only independent observations of those original requests.
const stages=['scope','plan','implementation','candidate','verification','release-decision','publication','closure'];
const unsupported={
};
const digest=/^sha256:[a-f0-9]{64}$/,numeric=/^[1-9][0-9]{0,19}$/;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function pinned(ref,digest,max=262144){
 assert.equal(fs.realpathSync(ref),ref);const st=fs.lstatSync(ref);
 assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0&&st.size<=max);
 const bytes=fs.readFileSync(ref);assert.equal(sha(bytes),digest);return bytes;
}
function exact(value,keys){assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...keys].sort());}
function privateBytes(ref,max=1048576){assert.equal(fs.realpathSync(ref),ref);const s=fs.lstatSync(ref);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size<=max);return fs.readFileSync(ref);}
function parseCodingHostStdout(stdout,phase){
 assert.equal(typeof stdout,'string');assert(Buffer.byteLength(stdout)>0&&Buffer.byteLength(stdout)<=1048576);assert(['inspect','claim','propose','submit'].includes(phase));
 // Preserve stdout verbatim in the original Host evidence. This is a separate
 // interpretation of exactly one Node 24.14 SQLite notice, not a log filter.
 const pattern=/\(node:([1-9][0-9]{0,9})\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g;
 const matches=[...stdout.matchAll(pattern)];assert(matches.length<=1,'Multiple notices are not the selected single-import output');let json=stdout,notice=null;
 if(matches.length){
  assert.equal(phase,'propose','Only the pinned propose phase imports the SQLite-backed configuration module');const m=matches[0],pid=Number(m[1]);assert(Number.isSafeInteger(pid)&&pid<=2147483647);
  const before=m.index===0,after=m.index+m[0].length===stdout.length;assert(before||after,'The notice must be a separate prefix or suffix, never inside the JSON value');if(after&&!before)assert.equal(stdout[m.index-1],'\n');json=stdout.slice(0,m.index)+stdout.slice(m.index+m[0].length);
  notice={kind:'NODE_SQLITE_EXPERIMENTAL_WARNING',nodeVersion:'v24.14.0',pid,position:before?'before-json':'after-json',bytes:Buffer.byteLength(m[0]),sha256:sha(m[0])};
 }
 assert(/^\{[^\r\n]*\}\n?$/.test(json),'Exactly one original JSON line and no other output is required');const value=JSON.parse(json);assert(value&&typeof value==='object'&&!Array.isArray(value));
 return{value,interpretation:{rawStdoutBytes:Buffer.byteLength(stdout),rawStdoutSha256:sha(stdout),jsonBytes:Buffer.byteLength(json),jsonSha256:sha(json),notice,originalToolOutputRetained:true,unknownOutputIgnored:false}};
}

const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";

// A local Codex rollout is an original observation source, not a signature or
// independently authenticated Host attestation. Read exact selected records;
// never evaluate their JavaScript or retain reasoning/system instructions.
function selectCodingHost(exchangeRoot){
 const ref=path.join(exchangeRoot,'CODING-HOST-SELECTION.json'),bytes=privateBytes(ref),s=JSON.parse(bytes);
 exact(s,['schema','rolloutRef','sessionId','preparationRoot','driverRef','driverSha256']);assert.equal(s.schema,'runtime-v090-coding-host-selection/v1');
 assert.equal(s.preparationRoot,path.dirname(exchangeRoot));assert.equal(fs.realpathSync(s.preparationRoot),s.preparationRoot);assert.equal(s.driverRef,path.join(s.preparationRoot,'current-codex.mjs'));pinned(s.driverRef,s.driverSha256,1048576);
 const sessions=fs.realpathSync(path.join(process.env.HOME,'.codex/sessions'));assert.equal(fs.realpathSync(s.rolloutRef),s.rolloutRef);assert(s.rolloutRef.startsWith(sessions+path.sep)&&s.rolloutRef.endsWith('.jsonl'));
 const stat=fs.lstatSync(s.rolloutRef);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.uid===process.getuid()&&(stat.mode&0o022)===0&&stat.size>0);
 const fd=fs.openSync(s.rolloutRef,'r');let first,cursor;
 try{const header=Buffer.alloc(Math.min(stat.size,1048576));fs.readSync(fd,header,0,header.length,0);const end=header.indexOf(10);assert(end>=0);first=header.subarray(0,end+1);const tail=Buffer.alloc(Math.min(stat.size,1048576));fs.readSync(fd,tail,0,tail.length,stat.size-tail.length);const last=tail.lastIndexOf(10);assert(last>=0);cursor=stat.size-tail.length+last+1;}finally{fs.closeSync(fd);}
 const meta=JSON.parse(first);assert.equal(meta.type,'session_meta');assert.equal(meta.payload.id,s.sessionId);assert.equal(meta.payload.session_id,s.sessionId);assert.equal(meta.payload.originator,'Codex Desktop');assert.equal(meta.payload.source,'vscode');assert.equal(typeof meta.payload.cli_version,'string');assert.equal(typeof meta.payload.model_provider,'string');
 return{selection:s,selectionRef:ref,selectionSha256:sha(bytes),inode:stat.ino,device:stat.dev,startOffset:cursor,metaSha256:sha(first),metaBytes:first.length,metadata:{sessionId:s.sessionId,hostVersion:meta.payload.cli_version,originator:meta.payload.originator,source:meta.payload.source,provider:meta.payload.model_provider},observedAt:new Date().toISOString()};
}

async function proveCodingHost(run,selected,handoff,reported,claim,nodeExecutable,valueDigest){
 const ref=path.join(run.selection.lifecycleExecution.exchangeRoot,'CODING-HOST-EVIDENCE.json');
 // The current Host writes this only after its SUBMITTED call has really
 // completed and both raw call/output records have reached the original log.
 const limit=Date.now()+60000;while(!fs.existsSync(ref)&&Date.now()<limit)await pause(250);
 assert(fs.existsSync(ref),'CODING_HOST_EVIDENCE_REQUIRED: original Host records must bind coding to this native request before the journey can pass');
 const proofBytes=privateBytes(ref),proof=JSON.parse(proofBytes);
 exact(proof,['schema','candidateDigest','stageRequestId','handoffDigest','claimDigest','reportDigest','turnContexts','inspect','claim','edits','validation','propose','submit']);assert.equal(proof.schema,'runtime-v090-coding-host-evidence/v1');assert.equal(proof.candidateDigest,run.candidateDigest);
 assert.equal(proof.stageRequestId,handoff.stageRequestId);assert.equal(proof.handoffDigest,handoff.digest);assert.equal(proof.claimDigest,claim.digest);assert.equal(proof.reportDigest,reported.digest);assert.equal(claim.host.sessionId,selected.metadata.sessionId);assert.equal(claim.host.version,selected.metadata.hostVersion);assert.equal(handoff.agent.version,selected.metadata.hostVersion);assert.equal(claim.handoffDigest,handoff.digest);assert.equal(reported.claimDigest,claim.digest);
 const current=fs.lstatSync(selected.selection.rolloutRef);assert.equal(current.ino,selected.inode);assert.equal(current.dev,selected.device);assert(current.size>=selected.startOffset);assert.equal(sha(privateBytes(selected.selectionRef)),selected.selectionSha256);pinned(selected.selection.driverRef,selected.selection.driverSha256,1048576);
 const fd=fs.openSync(selected.selection.rolloutRef,'r'),records=[],used=new Set(),turns=new Map();let total=0;
 function record(pin,kind,history=false){
  exact(pin,['offset','bytes','sha256']);assert(Number.isSafeInteger(pin.offset)&&pin.offset>=0&&Number.isSafeInteger(pin.bytes)&&pin.bytes>0&&pin.bytes<=1048576&&/^[a-f0-9]{64}$/.test(pin.sha256));assert(history||pin.offset>=selected.startOffset,'Historical Host events cannot qualify a new coding run');assert(pin.offset+pin.bytes<=current.size);assert(!used.has(pin.offset),'A source record cannot be reused as another action');used.add(pin.offset);total+=pin.bytes;assert(total<=16777216);
  const raw=Buffer.alloc(pin.bytes);assert.equal(fs.readSync(fd,raw,0,raw.length,pin.offset),raw.length);assert.equal(sha(raw),pin.sha256);assert.equal(raw.at(-1),10);assert.equal(raw.subarray(0,-1).indexOf(10),-1);if(pin.offset){const prior=Buffer.alloc(1);assert.equal(fs.readSync(fd,prior,0,1,pin.offset-1),1);assert.equal(prior[0],10);}
  const row=JSON.parse(raw);assert(Number.isFinite(Date.parse(row.timestamp)));assert(Number.isSafeInteger(row.ordinal));assert.equal(row.type,kind);records.push({pin,raw,row});return row;
 }
 function turn(row){const id=row.payload.internal_chat_message_metadata_passthrough?.turn_id,context=turns.get(id);assert(context,'Original tool record needs its exact original turn context');assert(context.ordinal<row.ordinal&&Date.parse(context.timestamp)<=Date.parse(row.timestamp));return id;}
 function pair(value){
  exact(value,['call','output']);const call=record(value.call,'response_item'),output=record(value.output,'response_item');assert.equal(call.payload.type,'custom_tool_call');assert.equal(call.payload.name,'exec');assert.equal(call.payload.status,'completed');assert.equal(output.payload.type,'custom_tool_call_output');assert.equal(call.payload.call_id,output.payload.call_id);assert.equal(turn(call),turn(output));assert(call.ordinal<output.ordinal&&Date.parse(call.timestamp)<=Date.parse(output.timestamp));
  assert.equal(typeof call.payload.input,'string');assert(Array.isArray(output.payload.output));return{call,output};
 }
 function parsedOutput(row){const values=[];for(const block of row.payload.output){assert.equal(block.type,'input_text');assert.equal(typeof block.text,'string');if(block.text.startsWith('{'))values.push(JSON.parse(block.text));else assert(block.text.startsWith('Script completed\n'),'Failed or unresolved tool execution is not a completed Host action');}return values;}
 function argumentsFor(call,method){const text=call.payload.input.trim(),prefix='text(await tools.'+method+'(';assert(text.startsWith(prefix)&&text.endsWith('));'),'Use one original tool invocation per provenance record');const args=JSON.parse(text.slice(prefix.length,-3));return args;}
 function execution(value,command,cwd){
  exact(value,['call','output','polls']);assert(Array.isArray(value.polls)&&value.polls.length<=32);const first=pair({call:value.call,output:value.output}),args=argumentsFor(first.call,'exec_command');
  exact(args,['cmd','workdir','login','yield_time_ms','max_output_tokens']);assert.equal(args.cmd,command);assert.equal(args.workdir,cwd);assert.equal(args.login,false);assert(Number.isInteger(args.yield_time_ms)&&args.yield_time_ms>=250&&args.yield_time_ms<=30000);assert(Number.isInteger(args.max_output_tokens)&&args.max_output_tokens>=2000&&args.max_output_tokens<=16000);
  const chunks=[];let observed=parsedOutput(first.output);assert.equal(observed.length,1);let result=observed[0],last=first.output;assert.equal(typeof result.output,'string');chunks.push(result.output);const sessionId=result.session_id;
  if(sessionId!==undefined)assert(Number.isSafeInteger(sessionId));
  for(const pin of value.polls){assert(result.exit_code===undefined&&result.session_id===sessionId,'Do not replay or poll a completed Host command');const next=pair(pin),poll=argumentsFor(next.call,'write_stdin');exact(poll,['session_id','chars','yield_time_ms','max_output_tokens']);assert.equal(poll.session_id,sessionId);assert.equal(poll.chars,'');assert(Number.isInteger(poll.yield_time_ms)&&poll.yield_time_ms>=1&&poll.yield_time_ms<=60000);assert(Number.isInteger(poll.max_output_tokens)&&poll.max_output_tokens>=2000&&poll.max_output_tokens<=16000);assert(next.call.ordinal>last.ordinal);observed=parsedOutput(next.output);assert.equal(observed.length,1);result=observed[0];assert.equal(typeof result.output,'string');chunks.push(result.output);last=next.output;}
  assert.equal(result.exit_code,0,'Only the original completed command establishes successful execution');assert.equal(result.session_id,undefined);const stdout=chunks.join('');assert(Buffer.byteLength(stdout)<=1048576);return{start:first.call.ordinal,end:last.ordinal,startedAt:first.call.timestamp,completedAt:last.timestamp,stdout,turnId:turn(first.call),callId:first.call.payload.call_id};
 }
 function phase(name){const cmd=quote(nodeExecutable)+' '+quote(selected.selection.driverRef)+' '+name,r=execution(proof[name],cmd,selected.selection.preparationRoot),parsed=parseCodingHostStdout(r.stdout,name),output=parsed.value;exact(output,['phase','stageRequestId','handoffDigest',...(name==='inspect'?['taskDigest']:['claimDigest']),...(['propose','submit'].includes(name)?['commit','change']:[]),...(name==='propose'?['artifacts']:[]),...(name==='submit'?['reportDigest']:[])]);assert.equal(output.phase,name);assert.equal(output.stageRequestId,handoff.stageRequestId);assert.equal(output.handoffDigest,handoff.digest);run.artifact('coding-host-stdout-interpretation.json',{phase:name,callId:r.callId,...parsed.interpretation});return{...r,value:output};}
 try{
  const meta=Buffer.alloc(selected.metaBytes);assert.equal(fs.readSync(fd,meta,0,meta.length,0),meta.length);assert.equal(sha(meta),selected.metaSha256);
  assert(Array.isArray(proof.turnContexts)&&proof.turnContexts.length>0&&proof.turnContexts.length<=16);for(const pin of proof.turnContexts){const r=record(pin,'turn_context',true),p=r.payload;assert.equal(typeof p.turn_id,'string');assert.equal(typeof p.model,'string');assert(p.model.length>0);if(turns.has(p.turn_id))assert.equal(turns.get(p.turn_id).model,p.model);else turns.set(p.turn_id,{model:p.model,provider:selected.metadata.provider,timestamp:r.timestamp,ordinal:r.ordinal});}
  const inspected=phase('inspect'),claimed=phase('claim');assert(inspected.end<claimed.start);assert.equal(inspected.value.taskDigest,valueDigest(handoff.preparation));assert.equal(claimed.value.claimDigest,claim.digest);
  assert(Date.parse(claimed.startedAt)<=Date.parse(claim.claimedAt)&&Date.parse(claim.claimedAt)<=Date.parse(claimed.completedAt),'Native claim must have occurred inside the original Host command');
  assert(Array.isArray(proof.edits)&&proof.edits.length>0&&proof.edits.length<=32);const changed=new Set(),allowed=new Set(reported.result.artifacts.map(a=>path.join(handoff.workspaceRoot,a.path)));let lastEdit=claimed.end;
  for(const evidence of proof.edits){const p=pair(evidence);assert(p.call.ordinal>lastEdit);const text=p.call.payload.input.trim(),prefix='text(await tools.apply_patch(';assert(text.startsWith(prefix)&&text.endsWith('));'));const patch=JSON.parse(text.slice(prefix.length,-3));assert.equal(typeof patch,'string');assert(patch.startsWith('*** Begin Patch\n')&&patch.trimEnd().endsWith('*** End Patch'));const paths=[...patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map(m=>m[1]);assert(paths.length>0);assert(!/^\*\*\* (?:Delete File|Move to):/m.test(patch));for(const file of paths){assert(allowed.has(file));assert(file.startsWith(handoff.workspaceRoot+path.sep));changed.add(file);}assert.deepEqual(parsedOutput(p.output),[{}]);lastEdit=p.output.ordinal;}
  for(const name of ['runtime-chain-probe/summary.sh','runtime-chain-probe/summary.test.sh'])assert(changed.has(path.join(handoff.workspaceRoot,name)),'Actual Host edits to both the implementation and its checks are required');
  const testCommand='/bin/bash '+quote(path.join(handoff.workspaceRoot,'runtime-chain-probe/summary.test.sh'))+' '+quote(path.join(handoff.workspaceRoot,'runtime-chain-probe/summary.sh')),validated=execution(proof.validation,testCommand,handoff.workspaceRoot);assert(validated.start>lastEdit);assert(validated.stdout.includes('checks=7 passed=7 failed=0'));
  const proposed=phase('propose'),submitted=phase('submit');assert(proposed.start>validated.end);assert(submitted.start>proposed.end);for(const r of [proposed,submitted]){assert.equal(r.value.claimDigest,claim.digest);assert.equal(r.value.commit,reported.result.commit);assert.deepEqual(r.value.change,reported.result.change);}assert.deepEqual(proposed.value.artifacts,reported.result.artifacts);assert.equal(submitted.value.reportDigest,reported.digest);
  assert(Date.parse(submitted.startedAt)<=Date.parse(reported.receivedAt)&&Date.parse(reported.receivedAt)<=Date.parse(submitted.completedAt),'Native report must have occurred inside the original Host command');
  await run.assertNoCredentialExposure([{name:'selected-original-coding-host-tool-records',text:records.filter(r=>r.row.type==='response_item').map(r=>r.raw.toString()).join('')}],{logs:false});
  for(const item of records){assert(Date.parse(item.row.timestamp)<=Date.parse(handoff.deadlineAt)+60000);const raw=Buffer.alloc(item.pin.bytes);assert.equal(fs.readSync(fd,raw,0,raw.length,item.pin.offset),raw.length);assert.equal(sha(raw),item.pin.sha256);if(item.row.type==='turn_context')run.artifact('coding-host-turn-context.json',{source: selected.selection.rolloutRef,pin:item.pin,turnId:item.row.payload.turn_id,model:item.row.payload.model,provider:selected.metadata.provider,recording:'Original turn metadata projection; instructions and reasoning omitted'});else run.artifact('coding-host-original-record.json',{source:selected.selection.rolloutRef,pin:item.pin,rawJsonl:item.raw.toString(),recording:'Original Codex tool call/output bytes; no reasoning or session instructions'});}
  assert.equal(sha(privateBytes(ref)),sha(proofBytes));assert.equal(sha(privateBytes(selected.selectionRef)),selected.selectionSha256);pinned(selected.selection.driverRef,selected.selection.driverSha256,1048576);
  const result={session:selected.metadata,source:selected.selection.rolloutRef,startOffset:selected.startOffset,proofSha256:sha(proofBytes),stageRequestId:handoff.stageRequestId,handoffDigest:handoff.digest,claimDigest:claim.digest,reportDigest:reported.digest,commit:reported.result.commit,change:reported.result.change,turns:[...turns].map(([turnId,value])=>({turnId,...value})),recordCount:records.length,originalToolChain:'VERIFIED_LOCAL_RECORD_BINDING',independentHostAttestation:false,cryptographicSignature:false};run.artifact('coding-host-original-proof-map.json',proof);run.artifact('coding-host-provenance.json',result);
  return{summary:result,revalidate(){
   assert.equal(fs.realpathSync(selected.selection.rolloutRef),selected.selection.rolloutRef);const st=fs.lstatSync(selected.selection.rolloutRef);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o022)===0);assert.equal(st.ino,selected.inode);assert.equal(st.dev,selected.device);
   assert.equal(sha(privateBytes(ref)),sha(proofBytes));assert.equal(sha(privateBytes(selected.selectionRef)),selected.selectionSha256);pinned(selected.selection.driverRef,selected.selection.driverSha256,1048576);
   const source=fs.openSync(selected.selection.rolloutRef,'r');try{const header=Buffer.alloc(selected.metaBytes);assert.equal(fs.readSync(source,header,0,header.length,0),header.length);assert.equal(sha(header),selected.metaSha256);for(const item of records){const raw=Buffer.alloc(item.pin.bytes);assert.equal(fs.readSync(source,raw,0,raw.length,item.pin.offset),raw.length);assert.equal(sha(raw),item.pin.sha256);}}finally{fs.closeSync(source);}
   return{recordCount:records.length,sourceSelectionSha256:selected.selectionSha256,proofSha256:sha(proofBytes),driverSha256:selected.selection.driverSha256,unchanged:true};
  }};
 }finally{fs.closeSync(fd);}
}
export async function executeE01(callableContext) {
 const run=await openScenario('E01',undefined,callableContext);let expert,browser,ui,primaryFailure;
 try{
  if(run.selection.caseCampaign){await collectCaseCampaign(run,'E01');return;}
 if(!run.cases.some(c=>c.caseInstanceId==='E01.journey')){for(const c of run.cases)await run.collect(c,async()=>{if(c.caseInstanceId==='E01.CV03')return collectManagedBudget(run,c,'github');if(c.caseInstanceId==='E01.variant.04')return collectStageAdmission(run,c,'github');if(c.caseInstanceId==='E01.CV07')return collectCoverageInventory(run,c);if(Object.hasOwn(LIFECYCLE_READBACK_CASES,c.caseInstanceId))return collectLifecycleReadback(run,c,'github',proveCodingHost);throw Error('UNIMPLEMENTED_ORIGINAL_CASE: '+unsupported[c.caseInstanceId]);});return;}
 const cfg=run.selection.lifecycleExecution;assert(cfg);const root=cfg.exchangeRoot;
 assert.equal(fs.realpathSync(root),root);assert.deepEqual(fs.readdirSync(root),['CODING-HOST-SELECTION.json'],'Only the preselected original Host source may exist before a new external Agent exchange');assert.equal(fs.lstatSync(root).mode&0o777,0o700);
 const selectedHost=selectCodingHost(root);
 assert(Number.isInteger(cfg.timeoutSeconds)&&cfg.timeoutSeconds>=300&&cfg.timeoutSeconds<=3600);
 const preparationBytes=pinned(cfg.preparationRef,cfg.preparationSha256),ownerFixtureBytes=pinned(cfg.ownerFixtureRef,cfg.ownerFixtureSha256),preparation=JSON.parse(preparationBytes),fixture=JSON.parse(ownerFixtureBytes);
 assert.equal(preparation.source.provider,'github');assert.equal(preparation.source.repositoryId,'1443052780');assert.equal(fixture.syntheticAssets,true);assert.equal(fixture.syntheticDecisions,true);assert.equal(fixture.workspaceId,run.selection.workspaceId);assert.equal(fixture.scope.projectId,run.selection.projectId);
 const scope={visibility:'private',projectId:run.selection.projectId};let serial=0,executionDeadline=null,executionInstanceId=null;
 const assertWriteDeadline=(stageDeadline=null)=>{if(executionDeadline!==null){assert(Number.isFinite(executionDeadline));if(stageDeadline!==null)assert(Number.isFinite(stageDeadline));assert(Date.now()<Math.min(executionDeadline,stageDeadline??executionDeadline),'Original native execution deadline elapsed; no new business write or retry permitted');}};
 const originalRequests=new Map(),interruptedReads=new Map();
 const inspectOriginal=async id=>{
  const original=await run.read('lifecycle.stage.request.inspect',{stageRequestId:id}),{request,progress}=original;
  assert.equal(request.id,id);assert.equal(request.instanceId,executionInstanceId);assert.equal(original.automaticRedispatch,false);assert.equal(original.workerError,null);
  const {digest:requestDigest,...content}=request;assert.equal(base.valueDigest(content),requestDigest);assert.equal(base.valueDigest(request.plan),request.planDigest);assert.equal(progress.requestId,id);
  let fixed=originalRequests.get(id);if(!fixed){fixed={request,handle:null};originalRequests.set(id,fixed);}else assert.deepEqual(request,fixed.request,'Original request, input/plan pins and deadline cannot change during observation');
  if(fixed.handle!==null)assert.deepEqual(progress.handle,fixed.handle,'Original provider handle cannot be replaced or lost');
  else if(progress.handle!==null){assert(typeof progress.handle==='object'&&!Array.isArray(progress.handle)&&Object.keys(progress.handle).length>0,'Actual nonempty provider handle required');fixed.handle=progress.handle;}
  assert.notEqual(progress.phase,'FAILED','Original execution failed; no retry or replacement is permitted');
  let interrupted=interruptedReads.get(id);
  if(progress.phase==='UNKNOWN'){
   assert.equal(progress.reason,'OBSERVATION_INTERRUPTED','Only a bounded read interruption may await automatic original-request observation');assert.equal(progress.terminal,false);assert(progress.handle!==null,'An interrupted original provider handle is required');
   if(!interrupted){
    const cutoff=Math.min(Date.now()+60000,Date.parse(request.deadlineAt),executionDeadline??Infinity);assert(Number.isFinite(cutoff));
    interrupted={deadline:cutoff,observations:new Set()};interruptedReads.set(id,interrupted);
   }
   if(!interrupted.observations.has(progress.observationRef)){
    const retained=await run.read('lifecycle.stage.observation.read',{stageRequestId:id,observationRef:progress.observationRef});assert.equal(base.valueDigest(retained.evidence),progress.observationRef);assert.equal(retained.evidence.requestId,id);assert.equal(retained.evidence.reason,'OBSERVATION_INTERRUPTED');assert.deepEqual(retained.evidence.observation,progress.observation);
    run.artifact('original-interrupted-observation.json',{request,progress,retained,readOnlyRecoveryDeadline:new Date(interrupted.deadline).toISOString(),newRequest:false,redispatch:false});interrupted.observations.add(progress.observationRef);
   }
   assert(Date.now()<interrupted.deadline,'Interrupted original request did not recover within its bounded remaining deadline');return{original,waiting:true};
  }
  if(interrupted){
   assert(Date.now()<interrupted.deadline,'Original recovery exceeded the selected read-only window');
   assert(progress.observation&&['WAITING_AGENT','CI_PENDING','CI_RUNNING','RUNNING','COMPLETE'].includes(progress.phase));
   const retained=await run.read('lifecycle.stage.observation.read',{stageRequestId:id,observationRef:progress.observationRef});assert.equal(base.valueDigest(retained.evidence),progress.observationRef);assert.equal(retained.evidence.requestId,id);assert.deepEqual(retained.evidence.observation,progress.observation);
   run.artifact('original-read-only-recovery.json',{request,progress,retained,interruptedObservationRefs:[...interrupted.observations],readOnlyRecoveryDeadline:new Date(interrupted.deadline).toISOString(),newRequest:false,redispatch:false});interruptedReads.delete(id);
  }
  return{original,waiting:false};
 };
 const save=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
 const syntheticDecision=subject=>{
  // Explicit test attestation, never an actual user's domain/release approval.
  const value={synthetic:true,message:'Isolated synthetic test attestation, not human or business authority',subject},source=JSON.stringify(value),sourcePath=path.join(root,'decision-'+(++serial)+'-source.json');fs.writeFileSync(sourcePath,source,{mode:0o600,flag:'wx'});
  const body=JSON.stringify({schema:'evopilot-decision-evidence/v1',subject,source:{reference:pathToFileURL(sourcePath).href+'#sha256='+sha(source),description:'Synthetic test fixture decision only'}}),ref=path.join(root,'decision-'+serial+'.json');fs.writeFileSync(ref,body,{mode:0o600,flag:'wx'});
  run.artifact('synthetic-decision.json',{subject,source:JSON.parse(source),evidence:JSON.parse(body),sourceDigest:sha(source),evidenceDigest:sha(body)});return pathToFileURL(ref).href+'#sha256='+sha(body);
 };
 const mutate=async(operation,input,label)=>{
  const requestId=run.requestId('E01.journey',label);
  for(let attempt=0;attempt<20;attempt++){
   assertWriteDeadline();let stageDeadline=null;
   if(input.stageRequestId){let observed;do{observed=await inspectOriginal(input.stageRequestId);if(observed.waiting)await pause(1000);}while(observed.waiting);stageDeadline=Date.parse(observed.original.request.deadlineAt);assert(Number.isFinite(stageDeadline));}
   const status=await run.read('runtime.status');assertWriteDeadline(stageDeadline);const r=await run.request(operation,input,{requestId,expectedRevision:status.revision});
   if(r.status===200)return r.body.result;
   // These two definite pre-effect rejections do not dispatch a stage. Keep
   // the same request key/input, inspect its original stage, and refresh CAS.
   // Transport UNKNOWN and all authority/semantic failures still stop here.
   if(operation==='lifecycle.stage.advance'&&['EXECUTOR_BUSY','REVISION_CONFLICT'].includes(r.body.error?.code)&&attempt<19){await run.read('lifecycle.stage.request.inspect',{stageRequestId:input.stageRequestId});await pause(600);continue;}
   assert.equal(r.status,200,JSON.stringify(r.body));
  }
  throw Error('Original stage advance remained busy; inspect before continuing');
 };
 const until=async(operation,input,predicate,label,seconds=300)=>{
  const end=Math.min(Date.now()+seconds*1000,executionDeadline??Infinity);let last;
  do{
   assert(Date.now()<end,'Original '+label+' inspection deadline elapsed');
   const observed=input.stageRequestId?await inspectOriginal(input.stageRequestId):null;
   if(observed?.waiting){await pause(1000);continue;}
   last=operation==='lifecycle.stage.request.inspect'?observed.original:await run.read(operation,input);assert(Date.now()<end,'Original '+label+' read returned after its selected deadline');if(predicate(last))return last;
   assert(!['FAILED','UNKNOWN'].includes(last.progress?.phase),'Inspect original '+label+' outcome; no redispatch');await pause(1000);
  }while(Date.now()<end);throw Error('Original '+label+' inspection deadline exceeded: '+JSON.stringify(last));
 };
 const stage=async(instanceId,stageId)=>{
  const allowed=await run.read('lifecycle.stage.admission',{instanceId,stageId});run.artifact('stage-admission.json',{stageId,actual:allowed});
  assert.equal(allowed.allowed,true,JSON.stringify(allowed.reasons));assert.deepEqual(allowed.reasons,[]);
  const r=await mutate('lifecycle.stage.request',{instanceId,stageId},'stage-'+stageId);return r.result.stageRequestId;
 };
 const complete=id=>until('lifecycle.stage.request.inspect',{stageRequestId:id},r=>r.progress.phase==='COMPLETE','stage completion');
 const advance=(id,label)=>mutate('lifecycle.stage.advance',{stageRequestId:id},label);
 const load=relative=>import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist',relative)).href);
 const control=await load('installation/service-control.js'),base=await load('lifecycle/base.js'),configApi=await load('adapters/config.js'),security=await load('server/security.js'),platformApi=await load('adapters/platforms.js'),artifactApi=await load('adapters/artifacts.js'),github=await load('adapters/github.js');
 const selectedService=control.inspectInstalledServiceSelection(run.selection.installedRoot);
 assert.equal(selectedService.serviceRoot,run.selection.installedRoot);assert.equal(selectedService.serviceId,run.candidate.serviceId);assert.equal(selectedService.distributionManifestDigest,run.candidate.manifestDigest);
 const spec=JSON.parse(fs.readFileSync(path.join(run.selection.installedRoot,'service-specification.json')));
 const service=async command=>{assert.equal(run.selection.browserConfiguration?.allowServiceRestart,true,'Select the bounded isolated stop/restart required by owner feedback and recovery');assert.deepEqual(control.inspectInstalledServiceSelection(run.selection.installedRoot),selectedService);const result=await control.operateInstalledService(selectedService,command);run.artifact('installed-service-control.json',{command,selection:selectedService,result});return result;};
 const actor=()=>{const value=security.currentPrincipal(path.join(run.selection.installedRoot,'data'),run.selection.workspaceId,spec.principalId);assert(value,'The original selected operator no longer exists');return value;};
 const configuration=()=>{assert(spec.integrationsRef);return configApi.readIntegrationConfiguration(spec.integrationsRef,run.selection.workspaceId);};
 const checkBinding=binding=>{assert.equal(binding.provider,'github');assert.equal(binding.host,'https://github.com');assert.equal(binding.repository,'yeliang-wang/evopilot-runtime-v090-e2e');assert.equal(binding.repositoryId,preparation.source.repositoryId);assert.equal(binding.projectId,run.selection.projectId);assert.deepEqual(configApi.configuredPlatform(configuration(),actor(),run.selection.projectId,binding.ref),binding);};
 function originalCi(r){
  const p=r.plan.parameters;assert.equal(r.workspaceId,run.selection.workspaceId);assert.equal(r.projectId,run.selection.projectId);assert.equal(p.commit,p.source.commit);assert.equal(p.stageId,r.stageId);assert.equal(r.plan.adapterId,'runtime-ci-owner-stage-v2');
  return platformApi.validateRunRequest({schema:'runtime-ci-request/v1',requestId:'stage-'+base.valueDigest({workspaceId:r.workspaceId,projectId:r.projectId,requestId:r.id}).slice(7,55),projectId:r.projectId,bindingDigest:base.valueDigest(p.binding),commit:p.commit,workflowDigest:p.workflowDigest,inputDigest:r.inputDigest,stageId:r.stageId,candidateDigest:p.candidateDigest,...(p.candidateInput?{candidateInput:p.candidateInput}:{}),requestedAt:r.requestedAt,deadlineAt:r.deadlineAt},p.binding);
 }
 async function githubEvidence(label,r,ci,expectedChecks,expectedArtifact=null){
  const p=r.plan.parameters;checkBinding(p.binding);assert.equal(r.planDigest,base.valueDigest(r.plan));assert.equal(ci.projectId,run.selection.projectId);assert.equal(ci.inputDigest,r.inputDigest);assert.equal(ci.commit,p.commit);assert.equal(ci.workflowDigest,p.workflowDigest);assert.equal(ci.stageId,r.stageId);
  platformApi.validateRunRequest(ci,p.binding);
  const credentials=async(binding,principal,signal)=>{signal.throwIfAborted();return configApi.readPlatformToken(spec.integrationsRef,binding,principal);};
  const client=github.githubClient(p.binding,credentials),transport=platformApi.platformReader(p.binding,credentials);
  const observed=await client.run(actor(),ci,expectedArtifact?.runId??null,AbortSignal.timeout(30000));
  run.artifact('github-original-run-observation.json',{stage:label,binding:p.binding,request:ci,observed});
  assert.equal(observed.status,'PASSED');assert.equal(observed.provider,'github');assert.equal(observed.repositoryId,preparation.source.repositoryId);assert.equal(observed.requestId,ci.requestId);assert.equal(observed.commit,ci.commit);assert.equal(observed.inputDigest,ci.inputDigest);assert.equal(observed.ref,platformApi.ciSourceRef(ci));assert(numeric.test(observed.runId));assert(observed.jobs.length>0);
  const rawRun=await transport.get(actor(),'/actions/runs/'+observed.runId,AbortSignal.timeout(15000));
  run.artifact('github-original-run.json',{stage:label,raw:rawRun});
  assert.equal(String(rawRun.id),observed.runId);assert.equal(String(rawRun.repository.id),preparation.source.repositoryId);assert.equal(rawRun.path,p.binding.workflowPath);assert.equal(rawRun.run_attempt,1);assert.equal(rawRun.event,'workflow_dispatch');assert.equal(rawRun.head_sha,ci.commit);assert.equal(rawRun.head_branch,platformApi.ciSourceRef(ci));assert.equal(rawRun.display_title,platformApi.ciRunTitle(ci));assert.equal(rawRun.conclusion,'success');
  for(const job of observed.jobs){
   assert.equal(job.status,'PASSED');assert.equal(job.runId,observed.runId);assert.equal(job.commit,ci.commit);assert(numeric.test(job.jobId)&&numeric.test(job.runnerId));
   const raw=await transport.get(actor(),'/actions/jobs/'+job.jobId,AbortSignal.timeout(15000));run.artifact('github-original-job.json',{stage:label,raw});
   assert.equal(String(raw.id),job.jobId);assert.equal(String(raw.run_id),observed.runId);assert.equal(raw.run_attempt,1);assert.equal(raw.head_sha,ci.commit);assert.equal(raw.status,'completed');assert.equal(raw.conclusion,'success');assert.equal(String(raw.runner_id),job.runnerId);assert(raw.labels.includes(p.binding.runner));
  }
  const archive=await client.artifact(actor(),ci,observed.runId,AbortSignal.timeout(60000));assert.equal(archive.provider,'github');assert.equal(archive.repositoryId,preparation.source.repositoryId);assert.equal(archive.jobId,null);assert(numeric.test(archive.artifactId));assert.equal(archive.name,'runtime-ci');assert.equal(archive.runId,observed.runId);assert.equal(archive.commit,ci.commit);assert.equal(archive.archiveBytes,archive.bytes.length);assert(archive.archiveBytes<=8388608,'The isolated fixture has an explicit 8 MiB archive bound');assert.equal(archive.archiveDigest,'sha256:'+sha(archive.bytes));
  const verified=await artifactApi.verifyCiArtifact(archive,ci,expectedChecks,AbortSignal.timeout(30000));assert.equal(verified.status,'PASSED');assert.equal(verified.artifactsVerified,true);assert.equal(verified.ownerEvaluationsVerified,false);assert.equal(verified.lifecycleAcceptance,false);if(expectedArtifact)assert.deepEqual(verified,expectedArtifact);
  const entries=await artifactApi.readArtifactArchive(archive.bytes,AbortSignal.timeout(30000)),result=JSON.parse(entries.get('runtime-result.json').toString());
  run.artifact('github-original-artifact.json',{stage:label,request:ci,verified,result,recording:'Exact installed adapter download and verification; not a source-test response'});
  for(let offset=0;offset<archive.bytes.length;offset+=262144){const bytes=archive.bytes.subarray(offset,offset+262144);run.artifact('github-original-archive-part.json',{stage:label,archiveDigest:archive.archiveDigest,archiveBytes:archive.archiveBytes,offset,bytes:bytes.length,sha256:sha(bytes),base64:bytes.toString('base64')});}
  return{request:ci,observation:observed,verified,client,transport};
 }
  for(const c of run.cases)await run.collect(c,async()=>{
   if(c.caseInstanceId==='E01.CV03')return collectManagedBudget(run,c,'github');if(c.caseInstanceId==='E01.variant.04')return collectStageAdmission(run,c,'github');if(c.caseInstanceId==='E01.CV07')return collectCoverageInventory(run,c);if(Object.hasOwn(LIFECYCLE_READBACK_CASES,c.caseInstanceId))return collectLifecycleReadback(run,c,'github',proveCodingHost,selectedHost);
   if(unsupported[c.caseInstanceId])throw Error('UNIMPLEMENTED_ORIGINAL_CASE: '+unsupported[c.caseInstanceId]);assert.equal(c.caseInstanceId,'E01.journey');
   const input=run.selection.expertConfiguration,yaml=pinned(input.ref,input.sha256).toString();assert(yaml.endsWith('\n')&&!yaml.endsWith('\n\n'));
   run.artifact('github-exact-fixture-inputs.json',{preparation,preparationSha256:cfg.preparationSha256,ownerFixtureSha256:cfg.ownerFixtureSha256,yaml,yamlSha256:input.sha256,syntheticAssets:true,syntheticDecisions:true});
   run.artifact('coding-host-source-selection.json',selectedHost);
   const runtime=await run.read('runtime.status');assert.equal(runtime.independentLlm,false);assert.equal(runtime.transport,'streamable-http');
   const ownerApi=await load('adapters/published-owners.js');
   for(const owner of ['ontology','harness']){const selected=configuration().owners.filter(o=>o.owner===owner&&o.workspaceRoot===fixture.workspaceRoot&&o.workspaceId===fixture.workspaceId&&o.projects.includes(run.selection.projectId));assert.equal(selected.length,1);assert.equal(selected[0].packageRoot,fixture.packageRoots[owner]);const identity=ownerApi.verifyOwnerDistribution(owner,fixture.packageRoots[owner]);run.artifact('published-owner-identity.json',identity);assert.equal(identity.version,'0.8.3');}
   const before=await run.read('lifecycle.definition.inspect');assert.equal(before.active,null,'Fresh installed project required');
   const preview=await run.read('lifecycle.definition.validate',{yaml});assert.equal(preview.ready,true,JSON.stringify(preview.issues));assert.equal(preview.compilation.effective.semantic.config.implementation.provider,'github');
   expert=await run.openExpert();
   const wizard=await expert.configurationTurn('Configure this isolated project with GitHub. Read lifecycle.base.inspect and lifecycle.definition.inspect. Ask for the necessary configuration for ALL eight Base stages, naming each exact stage ID and required GitHub fields in a single reply. GitLab-specific fields must not be required. Do not write or start execution. I will provide the complete approved test configuration next.');
   const text=wizard.messages.join('\n');for(const id of stages)assert(text.includes(id));assert(wizard.calls.some(c=>c.arguments.operation==='lifecycle.base.inspect'));assert(wizard.calls.some(c=>c.arguments.operation==='lifecycle.definition.inspect'));
   const write={operation:'lifecycle.definition.save-and-activate',projectId:run.selection.projectId,input:{yaml,validationDigest:preview.validationDigest},requestId:run.requestId(c.caseInstanceId,'activate'),expectedRevision:before.revision};
   const activated=await expert.configurationTurn('This is the already-approved synthetic test configuration. Validate the exact YAML through Runtime; only if ready is true, activate it once with lifecycle.definition.save-and-activate using requestId '+write.requestId+' and expectedRevision '+before.revision+'. Preserve one final LF. Then read back the active revision. Do not separately save, request routine confirmation, create decisions or start any stage.\n\n```yaml\n'+yaml+'```',write);
   assert(activated.calls.some(c=>c.arguments.operation==='lifecycle.definition.validate'));await expert.close();expert=null;
   const active=await run.read('lifecycle.definition.inspect');assert(active.active);assert.equal(await run.source(active.active.id),yaml);
   assert.deepEqual((await run.configurationEntry('cli','lifecycle.definition.inspect')).result,active);
   const prepared=await mutate('lifecycle.preparation.save',{...preparation,definitionRevisionId:active.active.id},'prepare');assert.equal(prepared.result.executionAuthorized,false);
   const instanceId=run.selection.runId,subject={instanceId,definitionRevisionId:active.active.id,goalRef:preparation.goalRef,targetRef:prepared.result.preparationRef,loopRef:preparation.loopRef,budget:preview.compilation.effective.semantic.config.plan.budget,expiresAt:new Date(Date.now()+cfg.timeoutSeconds*1000).toISOString()};
   executionInstanceId=instanceId;executionDeadline=Date.parse(subject.expiresAt);assertWriteDeadline();
   const auth=await run.read('lifecycle.authority.preview',{kind:'execution',subject}),evidenceRef=syntheticDecision({owner:'runtime',operation:'lifecycle.authority.execution',workspaceId:run.selection.workspaceId,scope,reviewDigest:auth.reviewDigest,decision:'APPROVE'});
   const decision=await mutate('lifecycle.authority.record',{kind:'execution',subject,reviewDigest:auth.reviewDigest,decision:'APPROVE',evidenceRef},'execution-decision');
   await mutate('lifecycle.instance.create',{instanceId,definitionRevisionId:active.active.id,authorityRef:decision.result.authorityRef},'instance');
   const originalInstance=(await run.read('lifecycle.instance.inspect',{instanceId})).instance,originalAuthority=await run.read('lifecycle.authority.inspect',{authorityRef:decision.result.authorityRef});assert.equal(originalInstance.id,instanceId);assert.equal(originalAuthority.usable,true);assert.equal(originalAuthority.decision.subject.instanceId,instanceId);assert.deepEqual(originalInstance.pins.budget,subject.budget);assert.deepEqual(originalAuthority.decision.subject.budget,subject.budget);assert.equal(originalInstance.pins.authorityExpiresAt,originalAuthority.decision.subject.expiresAt);
   executionDeadline=Math.min(executionDeadline,Date.parse(originalInstance.createdAt)+originalInstance.pins.budget.timeoutSeconds*1000,Date.parse(originalInstance.pins.authorityExpiresAt));assertWriteDeadline();run.artifact('original-native-execution-deadline.json',{instanceId,authorityRef:decision.result.authorityRef,createdAt:originalInstance.createdAt,budget:originalInstance.pins.budget,authorityExpiresAt:originalInstance.pins.authorityExpiresAt,deadlineAt:new Date(executionDeadline).toISOString(),extended:false});
   // Representative native predecessor denials do not stand in for the still
   // unimplemented full failed/unknown/permission/budget matrix.
   for(const stageId of stages.slice(1)){const denied=await run.read('lifecycle.stage.admission',{instanceId,stageId});assert.equal(denied.allowed,false);assert(denied.reasons.some(r=>r.startsWith('PREDECESSOR_NOT_PASSED:')));}

   browser=await chromium.launch();ui=await openBrowser(run,browser,{route:'/lifecycle',monitorEvidence:true});
   await expect(ui.source).toHaveValue(yaml);await ui.valid();await ui.screenshot();await ui.flush();
   await ui.step('Navigate to the independent read-only monitor',()=>ui.page.locator('nav a[href="/monitor"]').click());
   await expect(ui.page.getByRole('heading',{name:'生命周期监控',exact:true})).toBeVisible();await expect(ui.page.getByLabel('生命周期实例',{exact:true})).toHaveValue(instanceId);assert.equal(await ui.page.getByLabel('Project Lifecycle YAML').count(),0);
   const ids={},ciProofs={};
   for(const name of ['scope','plan']){ids[name]=await stage(instanceId,name);await complete(ids[name]);const proof=await run.read('lifecycle.'+name+'.evidence.read',{stageRequestId:ids[name]});run.artifact(name+'-original-evidence.json',proof);}
   ids.implementation=await stage(instanceId,'implementation');await until('lifecycle.stage.request.inspect',{stageRequestId:ids.implementation},r=>r.progress.phase==='WAITING_AGENT','actual Codex handoff');
   const handoff=await run.read('lifecycle.agent.handoff.read',{stageRequestId:ids.implementation});assert.equal(handoff.handoff.runtimeStartsAgent,false);
   save('HANDOFF.json',handoff);save('CALL-CONTEXT.json',{connectionRef:run.selection.connectionRef,projectId:run.selection.projectId,stageRequestId:ids.implementation,handoffDigest:handoff.handoff.digest,deadlineAt:handoff.handoff.deadlineAt,host:handoff.handoff.agent,capabilities:handoff.handoff.capabilities});
   process.stdout.write(JSON.stringify({waitingForActualCurrentCodex:true,exchangeRoot:root,stageRequestId:ids.implementation})+'\n');
   const reported=await until('lifecycle.agent.report.read',{stageRequestId:ids.implementation},r=>r.report?.state==='SUBMITTED','external current Codex',Math.min(1200,cfg.timeoutSeconds));
   const currentHandoff=await run.read('lifecycle.agent.handoff.read',{stageRequestId:ids.implementation});assert.deepEqual(currentHandoff.handoff,handoff.handoff);assert(currentHandoff.claim);assert.equal(currentHandoff.latestReport.digest,reported.report.digest);
   const codingHostProof=await proveCodingHost(run,selectedHost,handoff.handoff,reported.report,currentHandoff.claim,spec.nodeExecutable,base.valueDigest),codingHost=codingHostProof.summary;
   assert(reported.report.result.change.kind==='pull-request');const commit=reported.report.result.commit;
   const sourceReview=await run.read('lifecycle.implementation.review.preview',{stageRequestId:ids.implementation}),sourceEvidence=syntheticDecision({owner:'runtime',operation:'lifecycle.implementation.review',workspaceId:run.selection.workspaceId,scope,reviewDigest:sourceReview.reviewDigest,decision:'APPROVE'});
   assert.equal(sourceReview.source.schema,'runtime-source-observation/v1');assert.equal(sourceReview.source.provider,'github');assert.equal(sourceReview.source.repositoryId,preparation.source.repositoryId);assert.equal(sourceReview.source.baselineCommit,preparation.source.commit);assert.equal(sourceReview.source.commit,commit);assert.equal(sourceReview.source.state,'OPEN');assert.deepEqual(sourceReview.source.change,reported.report.result.change);assert.deepEqual(sourceReview.source.artifacts,reported.report.result.artifacts);assert.equal(sourceReview.review.agentReportDigest,reported.report.digest);assert.equal(sourceReview.source.sourceReviewApproved,false);assert.equal(sourceReview.source.releaseAuthorized,false);
   await mutate('lifecycle.implementation.review.record',{stageRequestId:ids.implementation,reviewDigest:sourceReview.reviewDigest,decision:'APPROVE',evidenceRef:sourceEvidence},'source-review');
   await advance(ids.implementation,'implementation-ci');await until('lifecycle.implementation.evidence.read',{stageRequestId:ids.implementation},r=>r.ci?.artifact?.status==='PASSED','implementation original CI');
   await advance(ids.implementation,'implementation-native');await complete(ids.implementation);
   const impl=await run.read('lifecycle.implementation.evidence.read',{stageRequestId:ids.implementation});assert.equal(impl.derivation.request.plan.parameters.commit,commit);assert.equal(impl.ci.owners.harness.receipt.result.qualityStatus,'PASS');
   ciProofs.implementation=await githubEvidence('implementation',impl.derivation.request,originalCi(impl.derivation.request),impl.derivation.request.plan.parameters.expectedChecks,impl.ci.artifact);
   const pr=await ciProofs.implementation.transport.get(actor(),'/pulls/'+reported.report.result.change.id,AbortSignal.timeout(15000));run.artifact('github-original-pull-request.json',{raw:pr,reviewDigest:sourceReview.reviewDigest});
   assert.equal(String(pr.number),reported.report.result.change.id);assert.equal(String(pr.base.repo.id),preparation.source.repositoryId);assert.equal(String(pr.head.repo.id),preparation.source.repositoryId);assert.equal(pr.head.sha,commit);assert.equal(pr.base.ref,impl.derivation.request.plan.parameters.binding.defaultBranch);assert.equal(pr.state,'open');
   for(const name of ['candidate','verification']){
    ids[name]=await stage(instanceId,name);await until('lifecycle.stage.request.inspect',{stageRequestId:ids[name]},r=>r.progress.phase==='RUNNING',name+' original CI');await advance(ids[name],name+'-native');const final=await complete(ids[name]);assert.equal(final.request.plan.parameters.commit,commit);
    ciProofs[name]=await githubEvidence(name,final.request,originalCi(final.request),final.request.plan.parameters.expectedChecks);
    if(name==='verification'){const archive=final.request.plan.parameters.candidateInput.archive;assert.equal(archive.provider,'github');assert.equal(archive.repositoryId,preparation.source.repositoryId);assert.equal(archive.jobId,null);for(const key of ['runId','artifactId'])assert(/^[1-9][0-9]{0,19}$/.test(archive[key]));}
   }
   const verified=await run.read('lifecycle.instance.inspect',{instanceId}),feedback=await run.read('lifecycle.verification.feedback.read',{stageRequestId:ids.verification});
   assert.equal(verified.instance.candidateDigest,ciProofs.candidate.verified.candidateDigest);assert.deepEqual(verified.instance.candidate,ciProofs.candidate.verified.candidate);assert.equal(ciProofs.verification.request.candidateDigest,verified.instance.candidateDigest);assert.deepEqual(ciProofs.verification.request.candidateInput.archive,ciProofs.candidate.verified.sourceArchive);assert.deepEqual(ciProofs.verification.request.candidateInput.manifest,verified.instance.candidate);assert.equal(feedback.event.stage,'SUCCEEDED');assert.equal(feedback.event.projectCandidateDigest,verified.instance.candidateDigest);for(const owner of ['ontology','harness'])assert.deepEqual(feedback.event.pins[owner],fixture.references[owner]);
   ids['release-decision']=await stage(instanceId,'release-decision');await until('lifecycle.stage.request.inspect',{stageRequestId:ids['release-decision']},r=>r.progress.phase==='RUNNING','release material');
   const material=await run.read('lifecycle.release.evidence.read',{stageRequestId:ids['release-decision']});assert.equal(material.material.documents.documents.length,4);
   const releaseSubject={instanceId,candidateDigest:verified.instance.candidateDigest,expiresAt:subject.expiresAt},releaseReview=await run.read('lifecycle.authority.preview',{kind:'release',subject:releaseSubject});assert.deepEqual(releaseReview.releaseMaterial,material.material);
   const releaseEvidence=syntheticDecision({owner:'runtime',operation:'lifecycle.authority.release',workspaceId:run.selection.workspaceId,scope,reviewDigest:releaseReview.reviewDigest,decision:'APPROVE'});
   await mutate('lifecycle.authority.record',{kind:'release',subject:releaseSubject,reviewDigest:releaseReview.reviewDigest,decision:'APPROVE',evidenceRef:releaseEvidence},'test-release-decision');await advance(ids['release-decision'],'release-decision-finish');await complete(ids['release-decision']);
   ids.publication=await stage(instanceId,'publication');await until('lifecycle.publication.evidence.read',{stageRequestId:ids.publication},r=>r.evidence?.artifact?.status==='PASSED','test publication original artifact');await advance(ids.publication,'publication-native');await complete(ids.publication);
   const publication=await run.read('lifecycle.publication.evidence.read',{stageRequestId:ids.publication}),publicationRequest=(await run.read('lifecycle.stage.request.inspect',{stageRequestId:ids.publication})).request;
   assert.equal(publicationRequest.plan.parameters.publication.target.packageName,null);assert.equal(publicationRequest.plan.parameters.publication.target.prerelease,true,'Only the dedicated synthetic Preview channel is in scope');assert.equal(publication.evidence.currentGrant,true);assert.equal(publication.evidence.harness.status,'PASS');
   ciProofs.publication=await githubEvidence('publication',publicationRequest,publication.ciRequest,publicationRequest.plan.parameters.expectedChecks,publication.evidence.artifact);
   const distribution=publication.evidence.distribution;assert.equal(distribution.schema,'runtime-distribution-observation/v1');assert.equal(distribution.provider,'github');assert.equal(distribution.repositoryId,preparation.source.repositoryId);assert.equal(distribution.commit,commit);assert.equal(distribution.candidateDigest,verified.instance.candidateDigest);assert.equal(distribution.status,'PASSED');assert.equal(distribution.releaseAuthorized,false);assert.equal(distribution.release.commit,commit);assert.equal(distribution.tag,publicationRequest.plan.parameters.publication.tag);assert.equal(distribution.artifacts.length,verified.instance.candidate.artifacts.length);
   for(const artifact of verified.instance.candidate.artifacts){const matches=distribution.artifacts.filter(a=>a.name===artifact.name);assert.equal(matches.length,1);assert.equal(matches[0].status,'PASSED');assert.equal(matches[0].digest,artifact.digest);assert.equal(matches[0].bytes,artifact.bytes);assert(numeric.test(matches[0].id));}
   const release=await ciProofs.publication.transport.get(actor(),'/releases/tags/'+encodeURIComponent(distribution.tag),AbortSignal.timeout(15000));run.artifact('github-original-release.json',{raw:release,distribution});assert.equal(String(release.id),distribution.release.id);assert.equal(release.tag_name,distribution.tag);assert.equal(release.draft,false);assert.equal(release.prerelease,true);assert.deepEqual(release.assets.map(a=>a.name).sort(),verified.instance.candidate.artifacts.map(a=>a.name).sort());
   for(const artifact of distribution.artifacts){const raw=release.assets.find(a=>a.name===artifact.name);assert.equal(String(raw.id),artifact.id);assert.equal(raw.size,artifact.bytes);assert.equal(raw.state,'uploaded');}
   const downloaded=await ciProofs.publication.client.distribution(actor(),{commit,candidate:verified.instance.candidate,tag:distribution.tag,prerelease:true,packageName:null,descriptionDigest:distribution.release.descriptionDigest},AbortSignal.timeout(60000));run.artifact('github-independent-distribution-readback.json',downloaded);assert.equal(downloaded.status,'PASSED');assert.equal(downloaded.factsDigest,distribution.factsDigest);
   ids.closure=await stage(instanceId,'closure');await until('lifecycle.closure.evidence.read',{stageRequestId:ids.closure},r=>r.evidence?.smoke?.status==='PASSED','original distribution smoke');await advance(ids.closure,'closure-native');
   // Advance acknowledges scheduling. Observe its original asynchronous owner
   // action and feedback delivery; never infer completion from that receipt or
   // issue another advance while it is running.
   const pendingFeedback=await until('lifecycle.closure.evidence.read',{stageRequestId:ids.closure},r=>r.evidence?.harness?.status==='PASS'&&['ontology','harness'].every(owner=>r.evidence.feedback?.[owner]?.status==='REVIEW_REQUIRED'),'original closure native action and feedback');assert.equal(pendingFeedback.archiveAction,null);
   const closureRequest=(await run.read('lifecycle.stage.request.inspect',{stageRequestId:ids.closure})).request;
   ciProofs.closure=await githubEvidence('closure',closureRequest,pendingFeedback.ciRequest.ci,['base.closure.delivery-acceptance'],pendingFeedback.evidence.smoke.ci);assert.equal(pendingFeedback.evidence.smoke.status,'PASSED');assert.equal(pendingFeedback.evidence.distribution.status,'PASSED');assert.equal(pendingFeedback.evidence.distribution.candidateDigest,verified.instance.candidateDigest);
   await ui.flush();assert(!ui.network.some(n=>n.request?.requestId),'Definition viewing and monitor must not perform business writes');await ui.close();ui=null;await service('stop');
   for(const owner of ['ontology','harness']){
    const api=await import(pathToFileURL(path.join(fixture.packageRoots[owner],'dist/service.js')).href);
    const material=async({reference,scope:requestedScope})=>{const a=await import(pathToFileURL(path.join(fixture.packageRoots[reference.product],'dist/service.js')).href),svc=a[reference.product==='ontology'?'createOntologyService':'createHarnessService']({workspaceRoot:fixture.workspaceRoot,workspaceId:fixture.workspaceId});svc.initialize();try{const r=await svc.native({operation:'native.package.readback',scope:requestedScope,input:{id:reference.id,version:reference.version}});return{reference:r.reference,scope:requestedScope,workspaceId:fixture.workspaceId,published:true,package:r.package};}finally{svc.close();}};
    const native=api[owner==='ontology'?'createOntologyService':'createHarnessService']({workspaceRoot:fixture.workspaceRoot,workspaceId:fixture.workspaceId},{readFeedback:async()=>feedback.event,resolveFeedbackMaterial:material});native.initialize();
    try{
     const write=async(operation,input,label)=>{assertWriteDeadline(Date.parse(closureRequest.deadlineAt));const request={operation,scope,input,requestId:run.requestId(c.caseInstanceId,label),expectedRevision:(await native.feedback({operation:'feedback.inspect',scope,input:{}})).revision};assertWriteDeadline(Date.parse(closureRequest.deadlineAt));const response=await native.feedback(request);run.artifact('owner-feedback-original.json',{owner,request,response});return response;};
     const review=await write('feedback.propose',{id:feedback.event.id,proposal:{mode:'REUSE',reference:fixture.references[owner],rationale:'Synthetic fixture disposition only; actual Runtime/GitHub evidence, no business domain decision',changes:[]}},owner+'-review');
     const humanEvidenceRef=syntheticDecision({owner,operation:'feedback.decide',workspaceId:fixture.workspaceId,scope,reviewDigest:review.result.reviewDigest,decision:'APPROVE'});
     await write('feedback.decide',{id:feedback.event.id,reviewDigest:review.result.reviewDigest,decision:'APPROVE',humanEvidenceRef},owner+'-decide');
    }finally{native.close();}
   }
   await service('start');await advance(ids.closure,'closure-archive');await complete(ids.closure);
   const closure=await run.read('lifecycle.closure.evidence.read',{stageRequestId:ids.closure}),final=await run.read('lifecycle.instance.inspect',{instanceId});assert.equal(closure.evidence.archive.status,'COMPLETE');for(const owner of ['ontology','harness'])assert.equal(closure.evidence.feedback[owner].status,'REUSE_APPROVED');for(const name of stages)assert.equal(final.instance.stages[name].status,'PASSED');
   assert.deepEqual(Object.keys(final.instance.stages).sort(),[...stages].sort());assert.equal(final.instance.candidateDigest,verified.instance.candidateDigest);
   for(const name of stages){const original=await run.read('lifecycle.stage.request.inspect',{stageRequestId:ids[name]}),observation=await run.read('lifecycle.stage.observation.read',{stageRequestId:ids[name],observationRef:original.progress.observationRef});assert.equal(original.progress.phase,'COMPLETE');assert.equal(original.automaticRedispatch,false);assert.equal(original.request.instanceId,instanceId);assert.equal(original.request.pinsDigest,final.instance.pinsDigest);assert.equal(original.request.inputDigest,final.instance.stages[name].inputDigest);assert.equal(base.valueDigest(observation.evidence),observation.observationRef);assert.deepEqual(observation.evidence.observation,original.progress.observation);assert.equal(base.valueDigest(original.progress.observation.outcome),final.instance.stages[name].outcomeDigest);const denied=await run.read('lifecycle.stage.admission',{instanceId,stageId:name});assert.equal(denied.allowed,false);assert(denied.reasons.includes('STAGE_ALREADY_COMPLETE'));}
   ui=await openBrowser(run,browser,{route:'/monitor',monitorEvidence:true});
   await expect(ui.page.getByLabel('生命周期实例',{exact:true})).toHaveValue(instanceId);await expect(ui.page.locator('tbody tr')).toHaveCount(8);await expect(ui.page.locator('tbody tr td:nth-child(2)')).toHaveText(Array(8).fill('已通过'));await ui.screenshot();await ui.flush();assert(!ui.network.some(n=>n.request?.requestId),'Monitor/readback must not perform business writes');
   await ui.close();ui=null;await browser.close();browser=null;
   await service('stop');await service('start');assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId})).instance,final.instance);assert.deepEqual(await run.read('lifecycle.closure.evidence.read',{stageRequestId:ids.closure}),closure);
   assert.deepEqual(pinned(cfg.preparationRef,cfg.preparationSha256),preparationBytes);assert.deepEqual(pinned(cfg.ownerFixtureRef,cfg.ownerFixtureSha256),ownerFixtureBytes);assert.equal(pinned(input.ref,input.sha256).toString(),yaml);
   run.artifact('coding-host-final-source-recheck.json',codingHostProof.revalidate());
   const ciIdentities=Object.fromEntries(Object.entries(ciProofs).map(([stage,v])=>[stage,{requestId:v.request.requestId,commit:v.request.commit,workflowDigest:v.request.workflowDigest,runId:v.observation.runId,jobs:v.observation.jobs.map(j=>({jobId:j.jobId,runnerId:j.runnerId})),archive:v.verified.sourceArchive,resultDigest:v.verified.resultDigest}]));assert.equal(new Set(Object.values(ciIdentities).map(v=>v.runId)).size,5);
   assert.equal((await run.read('runtime.status')).independentLlm,false);assert(digest.test(reported.report.digest));
   run.artifact('github-journey-summary.json',{stageRequests:ids,ciIdentities,commit,change:reported.report.result.change,actualExpert:{wizard,activated},codingHost,actualGitHub:true,syntheticAssets:true,syntheticDecisions:true,realProductReleased:false,dailyInstallationChanged:false});
   return{stageRequests:ids,ciIdentities,allEightPassed:true,commit,pullRequest:reported.report.result.change,independentLlm:false,actualExpert:true,authenticatedExternalReport:true,originalCodingHostRecordsBound:true,independentHostAttestation:false,actualBrowser:true,actualNativeOwners:true,exactCandidate:verified.instance.candidateDigest,assetGradeMeaning:'CONTENT_ONLY_NOT_SOFTWARE_ACCEPTANCE_OR_AUTHORITY',archiveSealed:true,originalFeedbackReviewed:true,restartPreservesClosure:true,remainingVariantsNotCredited:true};
  });
 }catch(error){primaryFailure=error;throw error;
 }finally{
  // Attempt every cleanup; a browser evidence error must not orphan the Host.
  const failures=[];
  for(const cleanup of [()=>ui?.close(),()=>browser?.close(),()=>expert?.close()])try{await cleanup();}catch(error){failures.push(error);}
  try{run.finish();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError([...(primaryFailure?[primaryFailure]:[]),...failures],'E01 cleanup/evidence was incomplete');
 }
}
if(process.argv[1]&&collectorPathToFileURL(collectorResolve(process.argv[1])).href===import.meta.url)test('E01 actual installed GitHub lifecycle with external Codex and native owners',caseCampaignTestOptions('E01'),executeE01);

// Fixed source-audited branches; no fixture or provider action runs at registration.
const E01_CALLABLE_ROUTES=Object.freeze({"E01.journey":{"handler":"executeE01 original GitHub lifecycle"},"E01.variant.01":{"handler":"collectLifecycleReadback/non-rc"},"E01.variant.02":{"handler":"collectLifecycleReadback/candidate-drift"},"E01.variant.03":{"handler":"collectLifecycleReadback/candidate-drift"},"E01.variant.04":{"handler":"collectStageAdmission"},"E01.variant.05":{"handler":"collectLifecycleReadback/feedback-publication"},"E01.CV03":{"handler":"collectManagedBudget"},"E01.CV07":{"handler":"collectCoverageInventory"}});
export function registerE01CallableCases(catalog){
 const routes=E01_CALLABLE_ROUTES;
 return registerFixedScenario({scenario:'E01',phase:'PRE_RELEASE',catalog,routes,execute:executeE01});
}
