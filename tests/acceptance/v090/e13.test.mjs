import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {openScenario} from './support.mjs';
import {openBrowser} from './browser.mjs';
import {exactKeys,interruptionFixture,openExecution} from './execution.mjs';

// The implemented branches consume an explicitly prepared isolated
// service. 01/02 require a genuinely admitted instance with real native scope
// and plan completion, and implementation still PENDING. They create only its
// original external-Agent handoff, never a Host claim/report, CI or Release.
// 05 remains unimplemented until real Host availability evidence is correlated
// with the exact original report and Target version. A null field alone proves
// omission, not unavailability; an actual unsupported or unavailable source can
// qualify without manufacturing a collection failure.
// 06 rejects an unsupported exact token cap through the native preview schema;
// it does not add token-budget semantics to Runtime's reporting addendum.
//
// interruptionFixture: {ref,sha256} -> runtime-v090-interruption-fixture/v1:
// {schema,candidateDigest,workspaceId,projectId,syntheticAssets:true,
//  syntheticDecisions:true,casePlans:{[fixedCaseId]:plan}}.
// 01/02 plan={instanceId,allowServiceRestart:true}; use distinct instances.
// 06 plan={instanceId,targetVersion}.
// 07/MC04 plan={}; each runs new actual browser conflicts and one activation.
// A fixture is selection, never a supplied expected outcome or new authority.
const unsupported={
 'E13.journey':'Full original Host, provider-channel interruption, cancellation and managed-action budget journey is not yet implemented.',
 'E13.variant.03':'Requires original native owner one-sided success and recovery without redispatch.',
 'E13.variant.04':'Requires actual test-channel response loss and independent original provider readback.',
 'E13.variant.05':'Requires original real Host availability evidence correlated with the exact report, task and Target version; measurement:null alone does not prove that metrics were unavailable.',
 'E13.CV03':'Requires the full original eight-stage admission and supported measured-budget matrix; one fixed loop is not a fabricated exhausted-loop result.',
 'E13.CV05':'Requires actual Host exit/reentry and exact authority recovery conversation.'
};
const slug=value=>assert(typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(value));
async function noReceipt(run,id){const result=await run.request('runtime.receipt.read',{requestId:id});assert.equal(result.status,404);assert.equal(result.body.error?.code,'NOT_FOUND');}
async function usage(run,targetVersion,instanceId){
 assert(typeof targetVersion==='string'&&targetVersion.length>0&&targetVersion.length<=256);
 const result=await run.read('usage.report.read',{targetVersion,instanceId,stageId:'implementation',format:'markdown'}),report=result.report;
 assert.equal(report.projectId,run.selection.projectId);assert.equal(report.instanceId,instanceId);assert.equal(report.stageId,'implementation');assert.equal(report.coverage,'REGISTERED_SOURCES_ONLY');assert.equal(report.completeVersionTotal,false);
 if(report.records===0){for(const count of Object.values(report.counts))assert.equal(count.recorded,null);assert.match(result.markdown,/未知/);}
 assert.match(result.markdown,/不代表整个版本的完整总量/);return result;
}
async function interruption(run,driver,c,plan){
 exactKeys(plan,['instanceId','allowServiceRestart']);slug(plan.instanceId);assert.equal(plan.allowServiceRestart,true);
 const before=await driver.instance(plan.instanceId),saved=before.instance;
 for(const stage of ['scope','plan'])assert.equal(saved.stages[stage].status,'PASSED','Use actual native prerequisite completion; no synthetic stage outcomes');
 const originalPreparations={};for(const stage of ['scope','plan'])originalPreparations[stage]=await run.read('lifecycle.'+stage+'.evidence.read',{stageRequestId:saved.stages[stage].requestId});
 assert.equal(saved.stages.implementation.status,'PENDING');assert.equal(saved.stages.implementation.attempts,0);assert.equal(saved.stages.implementation.requestId,null);
 const admission=await run.read('lifecycle.stage.admission',{instanceId:saved.id,stageId:'implementation'});assert.equal(admission.allowed,true);assert.equal(admission.executionDispatched,false);
 const baselineEvents=await driver.events(),view=await run.read('lifecycle.definition.inspect'),status=await run.read('runtime.status');
 const requestId=run.requestId(c.caseInstanceId,'original-implementation'),input={instanceId:saved.id,stageId:'implementation'},envelope={operation:'lifecycle.stage.request',projectId:run.selection.projectId,input,requestId,expectedRevision:status.revision};
 await noReceipt(run,requestId);
 const point=c.caseInstanceId.endsWith('.01')?'BEFORE_COMPLETE_REQUEST_BODY':'AFTER_RESPONSE_HEADERS_BEFORE_BODY';
 const fault=await driver.interrupt(envelope,point);
 let receipt;
 if(point==='BEFORE_COMPLETE_REQUEST_BODY'){
  await noReceipt(run,requestId);assert.deepEqual((await driver.instance(saved.id)).instance,saved);assert.equal((await run.read('runtime.status')).revision,status.revision);
  const committed=await run.request(envelope.operation,input,{requestId,expectedRevision:envelope.expectedRevision});assert.equal(committed.status,200);receipt=committed.body.result;
 }else receipt=await run.read('runtime.receipt.read',{requestId});
 assert.equal(receipt.operation,envelope.operation);assert.equal(receipt.requestId,requestId);assert.equal(receipt.result.status,'REQUEST_RETAINED');assert.equal(receipt.result.automaticRedispatch,false);
 const stageRequestId=receipt.result.stageRequestId,waiting=await driver.until(stageRequestId,value=>value.progress.phase==='WAITING_AGENT','original external Host handoff');
 assert.equal(waiting.request.stageId,'implementation');assert.equal(waiting.request.instanceId,saved.id);assert.equal(waiting.instance.pinsDigest,saved.pinsDigest);assert.equal(waiting.instance.stages.implementation.attempts,1);
 const handoff=await run.read('lifecycle.agent.handoff.read',{stageRequestId});assert.equal(handoff.handoff.runtimeStartsAgent,false);assert.equal(handoff.handoff.releaseAuthorized,false);assert.equal(handoff.claim,null);assert.equal(handoff.latestReport,null);driver.intact(handoff.handoff);
 const replay=await run.request(envelope.operation,input,{requestId,expectedRevision:envelope.expectedRevision});assert.equal(replay.status,200);assert.deepEqual(replay.body.result,receipt);
 const conflict=await run.request(envelope.operation,{...input,stageId:'candidate'},{requestId,expectedRevision:envelope.expectedRevision});assert.equal(conflict.status,409);assert.equal(conflict.body.error?.code,'REQUEST_CONFLICT');
 const duplicateId=run.requestId(c.caseInstanceId,'duplicate-stage'),duplicateStatus=await run.read('runtime.status');
 const duplicate=await run.request(envelope.operation,input,{requestId:duplicateId,expectedRevision:duplicateStatus.revision});assert.equal(duplicate.status,409);assert.equal(duplicate.body.error?.code,'STAGE_BLOCKED');assert.match(duplicate.body.error.message,/RECONCILE_ORIGINAL_REQUEST/);await noReceipt(run,duplicateId);
 // The exact original grant pins one instance and one loopRef. Prove it cannot
 // create a second instance; do not invent a loop counter or exhaustion reason.
 const authority=await run.read('lifecycle.authority.inspect',{authorityRef:waiting.request.authorityRef});assert.equal(authority.usable,true);assert.equal(authority.decision.subject.instanceId,saved.id);assert.equal(authority.decision.subject.loopRef,saved.pins.loopRef);
 const otherId=run.requestId(c.caseInstanceId,'other-instance'),otherRequest=run.requestId(c.caseInstanceId,'reuse-grant'),prior=await run.read('runtime.status');
 const rejected=await run.request('lifecycle.instance.create',{instanceId:otherId,definitionRevisionId:saved.pins.definitionRevisionId,authorityRef:waiting.request.authorityRef},{requestId:otherRequest,expectedRevision:prior.revision});
 assert.equal(rejected.status,400);assert.equal(rejected.body.error?.code,'AUTHORITY_MISMATCH');await noReceipt(run,otherRequest);
 const absent=await run.request('lifecycle.instance.inspect',{instanceId:otherId});assert.equal(absent.status,404);assert.equal(absent.body.error?.code,'NOT_FOUND');
 await driver.restart();
 const recovered=await driver.until(stageRequestId,value=>value.progress.phase==='WAITING_AGENT','original handoff after native service restart');
 assert.deepEqual(recovered.request,waiting.request);assert.equal(recovered.instance.pinsDigest,saved.pinsDigest);assert.equal(recovered.instance.pins.loopRef,saved.pins.loopRef);assert.equal(recovered.instance.stages.implementation.attempts,1);
 assert.deepEqual(await run.read('runtime.receipt.read',{requestId}),receipt);assert.deepEqual(await run.read('lifecycle.agent.handoff.read',{stageRequestId}),handoff);
 for(const stage of ['scope','plan'])assert.deepEqual(await run.read('lifecycle.'+stage+'.evidence.read',{stageRequestId:saved.stages[stage].requestId}),originalPreparations[stage]);
 const finalView=await run.read('lifecycle.definition.inspect');assert.deepEqual(finalView.active,view.active);assert.deepEqual(finalView.draft,view.draft);
 const afterEvents=await driver.events();assert.deepEqual(afterEvents.slice(0,baselineEvents.length),baselineEvents);
 const added=afterEvents.slice(baselineEvents.length),requested=added.filter(e=>e.type==='stage-requested'),retained=added.filter(e=>e.type==='agent-handoff-retained');
 assert.equal(requested.length,1);assert.equal(requested[0].data.stageRequestId,stageRequestId);assert.equal(retained.length,1);assert.equal(retained[0].data.stageRequestId,stageRequestId);assert.equal(retained[0].data.startsAgent,false);
 assert(!added.some(e=>['lifecycle-instance-created','agent-claimed','agent-reported','stage-advance-requested'].includes(e.type)),'Recovery cannot create an extra instance, Host result or continuation');
 run.artifact('interruption-original-summary.json',{fault,requestId,receipt,stageRequestId,pinsDigest:saved.pinsDigest,loopRef:saved.pins.loopRef,addedEvents:added,originalPreparationEvidenceUnchanged:true,hostReportSubmitted:false,providerCallsMeasured:false,actualBusinessRunCountClaim:null});
 return{faultPoint:point,originalRequestId:requestId,stageRequestId,originalReceiptRecovered:true,sameKeySameResult:true,sameKeyChangedContentRejected:true,differentKeyDuplicateStageRejected:true,nativeServiceRestart:true,originalHandoffRecovered:true,stageAdmissionEvents:requested.length,handoffEvents:retained.length,implementationAttempts:1,grantCannotCreateSecondInstance:true,pinnedMaxLoops:saved.pins.budget.maxLoops,loopBudgetSemantics:'EXACT_SINGLE_LOOP_PIN_AND_NO_DUPLICATE_ADMISSION',runtimeStartedAgent:false,hostReportSubmitted:false,fullJourneyNotCredited:true};
}
async function unsupportedLimit(run,driver,c,plan){
 exactKeys(plan,['instanceId','targetVersion']);slug(plan.instanceId);
 const before=await driver.instance(plan.instanceId),view=await run.read('lifecycle.definition.inspect');assert.equal(view.active.id,before.instance.pins.definitionRevisionId);
 const report=await usage(run,plan.targetVersion,plan.instanceId),status=await run.read('runtime.status'),pins=before.instance.pins;
 assert.equal(report.report.counts.total.recorded,null,'This branch requires genuinely unavailable exact usage, not a fabricated zero or a known metered total');
 const subject={instanceId:run.requestId(c.caseInstanceId,'unsupported-token-limit'),definitionRevisionId:pins.definitionRevisionId,goalRef:pins.goalRef,targetRef:pins.targetRef,loopRef:pins.loopRef,budget:{...pins.budget,maxTokens:1},expiresAt:new Date(Date.now()+30000).toISOString()};
 const rejected=await run.request('lifecycle.authority.preview',{kind:'execution',subject});assert.equal(rejected.status,400);assert.equal(rejected.body.error?.code,'INVALID_FIELDS','An unsupported exact usage limit must not silently become an unenforced authority');
 const after=await run.read('runtime.status');assert.equal(after.revision,status.revision);assert.deepEqual((await driver.instance(plan.instanceId)).instance,before.instance);
 const absent=await run.request('lifecycle.instance.inspect',{instanceId:subject.instanceId});assert.equal(absent.status,404);assert.equal(absent.body.error?.code,'NOT_FOUND');
 await usage(run,plan.targetVersion,plan.instanceId);
 return{unsupportedConstraint:'budget.maxTokens',requestedLimit:1,nativeRejection:rejected.body.error.code,authorityGranted:false,executionDispatched:false,existingInstanceUnchanged:true,normalReadbackStillAvailable:true,usageCoverage:report.report.coverage,newBudgetEngine:false,unknownUsageTreatedAsZero:false};
}

async function definitionConflict(run,driver,c,plan){
 exactKeys(plan,[]);
 const view=await run.read('lifecycle.definition.inspect');assert(view.active);
 const originalSource=await run.source(view.active.id),validation=await run.read('lifecycle.definition.validate',{yaml:originalSource});assert.equal(validation.ready,true);
 const baselineEvents=await driver.events(),baselineSources={};
 for(const revision of [view.active,view.draft].filter(Boolean))baselineSources[revision.id]=await run.source(revision.id);
 const restored=await run.request('lifecycle.draft.save',{yaml:originalSource},{requestId:run.requestId(c.caseInstanceId,'initial-draft'),expectedRevision:view.revision});assert.equal(restored.status,200);assert.equal(restored.body.result.result.status,'DRAFT');
 const browser=await chromium.launch({headless:true});let first,second,recovery,observer,routeFailure;
 try{
  first=await openBrowser(run,browser);second=await openBrowser(run,browser);
  const before=await first.monitor();assert.equal(before.nextAfter,null,'Use the bounded isolated interruption project, not a partial instance page');
  const instances={};for(const row of before.instances)instances[row.id]=(await driver.instance(row.id)).instance;
  const staleSource=originalSource+'\n# E13 stale '+c.caseInstanceId+' '+run.selection.runId+'\n';
  await first.source.fill(staleSource);await first.preview();await expect(first.page.getByRole('button',{name:'保存并启用',exact:true})).toBeEnabled();
  const concurrentSource=originalSource+'\n# E13 concurrent '+c.caseInstanceId+' '+run.selection.runId+'\n';
  await second.source.fill(concurrentSource);await second.save();
  await first.page.getByRole('button',{name:'保存并启用',exact:true}).click();await expect(first.page.getByRole('button',{name:'重新读取',exact:true})).toBeVisible();await expect(first.source).toHaveValue(staleSource);await first.flush();
  const refused=first.network.filter(n=>n.request.operation==='lifecycle.definition.save-and-activate');assert.equal(refused.length,1);assert.equal(refused[0].status,409);assert.equal(JSON.parse(refused[0].rawBody).error.code,'REVISION_CONFLICT');
  const afterConflict=await run.read('lifecycle.definition.inspect');assert.deepEqual(afterConflict.active,view.active);assert.equal(await run.source(afterConflict.draft.id),concurrentSource);
  await second.preview();await second.source.fill(concurrentSource+'# edit invalidates preview\n');await expect(second.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();await second.save();
  await first.close();await second.close();
  recovery=await openBrowser(run,browser);observer=await openBrowser(run,browser);
  const source=await recovery.source.inputValue()+'# original response loss '+c.caseInstanceId+'\n';await recovery.source.fill(source);await recovery.preview();
  let submitted=0,envelope,receipt;
  await recovery.page.route('**/api/v1/dashboard/request',async route=>{
   const input=route.request().postDataJSON();if(input.operation!=='lifecycle.definition.save-and-activate')return route.continue();
   try{
    assert.equal(++submitted,1,'Never redispatch an activation with an unknown response');envelope=input;
    const response=await route.fetch({timeout:30000,maxRetries:0});assert.equal(response.status(),200);receipt=await response.json();
    run.artifact('definition-commit-response-loss.json',{fault:'EXPLICIT_BROWSER_RESPONSE_LOSS_AFTER_REAL_SERVICE_COMMIT',request:envelope,status:response.status(),body:receipt,browserReceivedResponse:false,transportCancellationImpliesRollback:false});
    await route.abort('connectionreset');
   }catch(error){routeFailure=error;try{await route.abort('failed');}catch{}}
  });
  await recovery.page.getByRole('button',{name:'保存并启用',exact:true}).click();await expect(recovery.page.getByRole('button',{name:'核对原请求',exact:true})).toBeEnabled();if(routeFailure)throw routeFailure;
  await expect(recovery.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();await recovery.page.getByRole('button',{name:'核对原请求',exact:true}).click();await expect(recovery.page.getByRole('button',{name:'重新读取',exact:true})).toBeVisible();assert.equal(submitted,1);
  const retained=await run.read('runtime.receipt.read',{requestId:envelope.requestId});assert.deepEqual(retained,receipt.result);assert.equal(retained.result.status,'ACTIVE');assert.equal(retained.result.executionAuthorized,false);assert.equal(retained.result.releaseAuthorized,false);
  const replay=await recovery.sessionRequest(envelope.operation,envelope.input,{requestId:envelope.requestId,expectedRevision:envelope.expectedRevision});assert.equal(replay.status,200);assert.deepEqual(replay.body.result,retained);
  const changed=await recovery.sessionRequest(envelope.operation,{...envelope.input,yaml:source+'# forbidden same-key change\n'},{requestId:envelope.requestId,expectedRevision:envelope.expectedRevision});assert.equal(changed.status,409);assert.equal(changed.body.error.code,'REQUEST_CONFLICT');
  const finalView=await run.read('lifecycle.definition.inspect');assert.equal(finalView.active.id,retained.result.revisionId);assert.equal(await run.source(finalView.active.id),source);assert.equal(finalView.active.semanticDigest,view.active.semanticDigest);
  for(const ui of [recovery,observer]){const readback=await ui.sessionRequest('lifecycle.definition.inspect');assert.equal(readback.status,200);assert.deepEqual(readback.body.result.active,finalView.active);assert.deepEqual((await ui.monitor()).instances,before.instances);await ui.flush();}
  for(const [id,value]of Object.entries(instances))assert.deepEqual((await driver.instance(id)).instance,value,'Definition editing cannot execute or repin an existing instance');
  for(const [id,value]of Object.entries(baselineSources))assert.equal(await run.source(id),value);
  const events=await driver.events();assert.deepEqual(events.slice(0,baselineEvents.length),baselineEvents);const added=events.slice(baselineEvents.length),activations=added.filter(e=>e.type==='definition-activated');assert.equal(activations.length,1);assert.equal(activations[0].data.revisionId,finalView.active.id);
  assert(added.every(e=>['definition-draft-saved','definition-activated'].includes(e.type)),'No new instance, stage, grant, Agent, CI or owner dispatch may occur');
  run.artifact('definition-concurrency-recovery.json',{caseInstanceId:c.caseInstanceId,originalRequest:envelope,receipt:retained,staleRefusal:JSON.parse(refused[0].rawBody),priorActive:view.active,currentActive:finalView.active,addedEvents:added,existingInstancesUnchanged:Object.keys(instances),originalSourcesUnchanged:Object.keys(baselineSources),sameKeyReplay:replay.body,sameKeyChangedContent:changed.body});
  return{twoActualBrowserClients:true,staleRevisionRejected:true,editInvalidatesPreview:true,postCommitResponseLost:true,originalRequestReconciled:true,automaticRedispatch:false,activationEvents:activations.length,sameKeySameResult:true,sameKeyChangedContentRejected:true,bothClientsReadSameActive:true,existingInstancesUnchanged:true,executionDispatched:false};
 }finally{
  const failures=[];for(const ui of [first,second,recovery,observer])if(ui)try{await ui.close();}catch(error){failures.push(error);}await browser.close();if(failures.length)throw new AggregateError(failures,'E13 browser evidence cleanup failed');
 }
}

const CV04_PYTHON_DRIVER="import datetime\nimport hashlib\nimport json\nimport lldb\nimport os\nimport shlex\nimport signal\nimport subprocess\nimport stat\nimport time\n\n\ndef now():\n    return datetime.datetime.now(datetime.timezone.utc).isoformat()\n\n\ndef exact_file(ref, limit=262144):\n    info = os.lstat(ref)\n    assert stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)\n    assert info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600\n    assert info.st_nlink == 1 and info.st_size <= limit\n    assert os.path.realpath(ref) == ref\n    with open(ref, 'rb') as reader:\n        return reader.read()\n\n\ndef write_new(ref, value):\n    encoded = (json.dumps(value, indent=2) + '\\n').encode()\n    descriptor = os.open(ref, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)\n    try:\n        os.write(descriptor, encoded)\n        os.fsync(descriptor)\n    finally:\n        os.close(descriptor)\n\n\ndef run(debugger, command, result, internal_dict):\n    args = shlex.split(command)\n    assert len(args) == 1\n    input_ref = args[0]\n    config = json.loads(exact_file(input_ref))\n    assert set(config) == {'schema', 'mode', 'pid', 'nodeExecutable', 'nodeSha256', 'root', 'deadline', 'identityRef', 'identitySha256'}\n    assert config['schema'] == 'runtime-owned-sqlite-fault-driver/v1'\n    assert config['mode'] in ['CALIBRATION_ONLY', 'BEFORE_BEGIN', 'INSIDE_TRANSACTION_BEFORE_COMMIT', 'AFTER_COMMIT_BEFORE_RESPONSE']\n    root = config['root']\n    assert os.path.dirname(input_ref) == root and os.path.realpath(root) == root\n    assert stat.S_IMODE(os.stat(root).st_mode) == 0o700\n    identity_bytes = exact_file(config['identityRef'])\n    assert hashlib.sha256(identity_bytes).hexdigest() == config['identitySha256']\n    identity = json.loads(identity_bytes)\n    assert identity['pid'] == config['pid'] and identity['nodeExecutable'] == config['nodeExecutable']\n    assert identity['ownedByThisPacket'] is True and identity['existingService'] is False\n    if config['mode'] == 'CALIBRATION_ONLY':\n        assert identity['kind'] == 'MEMORY_SQLITE_CALIBRATION' and identity['secrets'] is False\n    else:\n        assert identity['kind'] == 'EXACT_INSTALLED_RUNTIME_FAULT' and identity['faultExecutionReviewed'] is True\n        assert identity['selectionDigest'] and identity['candidateDigest'] and identity['serviceId']\n    node = config['nodeExecutable']\n    assert os.path.realpath(node) == node and node == '/usr/local/bin/node'\n    with open(node, 'rb') as reader:\n        assert hashlib.sha256(reader.read()).hexdigest() == config['nodeSha256']\n    deadline = datetime.datetime.fromisoformat(config['deadline'].replace('Z', '+00:00')).timestamp()\n    assert time.time() < deadline <= time.time() + 60\n    events = []\n    process = None\n    killed = False\n    error_text = None\n    status = 'NOT_COMPLETED'\n    target = None\n\n    def event(kind, **fields):\n        item = {'kind': kind, 'at': now(), **fields}\n        events.append(item)\n        result.PutCString(json.dumps(item))\n\n    def verify_process_identity(phase):\n        if config['mode'] == 'CALIBRATION_ONLY':\n            return\n        expected = identity.get('processIdentity')\n        assert isinstance(expected, str) and expected, 'MISSING_FIXED_PROCESS_START_IDENTITY'\n        observed = subprocess.run(['/bin/ps', '-p', str(config['pid']), '-o', 'pid=,lstart=,comm='], check=True, text=True, capture_output=True, timeout=2, env={'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8'}).stdout.strip()\n        assert observed == expected, 'OWNED_PROCESS_START_IDENTITY_CHANGED'\n        event('PROCESS_IDENTITY_VERIFIED', phase=phase, pid=config['pid'], processIdentity=observed)\n\n    def current():\n        assert time.time() < deadline, 'FIXED_DEBUGGER_DEADLINE'\n        assert process.GetProcessID() == config['pid']\n        assert process.GetState() == lldb.eStateStopped\n        thread = process.GetSelectedThread()\n        if thread.GetStopReason() == lldb.eStopReasonNone:\n            candidates = [process.GetThreadAtIndex(i) for i in range(process.GetNumThreads()) if process.GetThreadAtIndex(i).GetStopReason() != lldb.eStopReasonNone]\n            assert len(candidates) == 1\n            thread = candidates[0]\n        return thread\n\n    def frame_data(thread):\n        frames = []\n        for index in range(min(thread.GetNumFrames(), 16)):\n            frame = thread.GetFrameAtIndex(index)\n            frames.append({'index': index, 'pc': hex(frame.GetPC()), 'function': frame.GetFunctionName(), 'module': str(frame.GetModule().GetFileSpec())})\n        return frames\n\n    def entry(sql, prior_database=None):\n        thread = current()\n        assert thread.GetStopReason() == lldb.eStopReasonBreakpoint\n        frame = thread.GetFrameAtIndex(0)\n        assert frame.GetPC() == address\n        assert os.path.realpath(str(frame.GetModule().GetFileSpec())) == node\n        database = frame.FindRegister('x0').GetValueAsUnsigned()\n        pointer = frame.FindRegister('x1').GetValueAsUnsigned()\n        read_error = lldb.SBError()\n        value = process.ReadCStringFromMemory(pointer, 128, read_error)\n        assert read_error.Success() and value == sql, 'UNEXPECTED_SQL_AT_EXACT_TRANSACTION_BOUNDARY'\n        if prior_database is not None:\n            assert prior_database == database, 'DIFFERENT_DATABASE_TRANSACTION'\n        event('SQL_ENTRY', sql=value, databasePointer=hex(database), sqlPointer=hex(pointer), threadId=thread.GetThreadID(), breakpointId=breakpoint.GetID(), frames=frame_data(thread))\n        return database, thread\n\n    def leave(thread, sql):\n        thread.StepOut()\n        stopped = current()\n        assert stopped.GetThreadID() == thread.GetThreadID()\n        assert stopped.GetStopReason() == lldb.eStopReasonPlanComplete\n        code = stopped.GetFrameAtIndex(0).FindRegister('x0').GetValueAsUnsigned()\n        assert code == 0, 'SQLITE_EXEC_DID_NOT_RETURN_OK'\n        event('SQL_RETURN', sql=sql, sqliteCode=code, threadId=stopped.GetThreadID(), stopReason='PLAN_COMPLETE', frames=frame_data(stopped))\n\n    def kill_owned(point):\n        nonlocal killed\n        current()\n        verify_process_identity('BEFORE_SIGKILL')\n        current()\n        event('OWNED_SIGKILL', point=point, pid=config['pid'])\n        os.kill(config['pid'], signal.SIGKILL)\n        killed = True\n\n    try:\n        debugger.SetAsync(False)\n        target = debugger.CreateTarget(node)\n        assert target.IsValid() and target.GetTriple().startswith('arm64-')\n        attach_error = lldb.SBError()\n        process = target.AttachToProcessWithID(debugger.GetListener(), config['pid'], attach_error)\n        assert attach_error.Success() and process.IsValid(), str(attach_error)\n        current()\n        modules = [target.GetModuleAtIndex(i) for i in range(target.GetNumModules()) if os.path.realpath(str(target.GetModuleAtIndex(i).GetFileSpec())) == node]\n        assert len(modules) == 1\n        module = modules[0]\n        symbols = module.FindSymbols('sqlite3_exec', lldb.eSymbolTypeCode)\n        assert symbols.GetSize() == 1\n        symbol = symbols.GetContextAtIndex(0).GetSymbol()\n        address = symbol.GetStartAddress().GetLoadAddress(target)\n        assert address != lldb.LLDB_INVALID_ADDRESS\n        breakpoint = target.BreakpointCreateByAddress(address)\n        assert breakpoint.GetNumLocations() == 1 and breakpoint.GetLocationAtIndex(0).IsResolved()\n        event('ATTACHED_AND_ARMED', pid=config['pid'], mode=config['mode'], nodeModule=str(module.GetFileSpec()), moduleUuid=module.GetUUIDString(), architecture=target.GetTriple(), symbol=symbol.GetName(), entryAddress=hex(address), breakpointId=breakpoint.GetID(), skipPrologue=False)\n        verify_process_identity('AFTER_ATTACH')\n        write_new(os.path.join(root, 'ARMED.json'), {'schema': 'runtime-owned-debugger-armed/v1', 'pid': config['pid'], 'mode': config['mode'], 'at': now(), 'inputSha256': hashlib.sha256(exact_file(input_ref)).hexdigest()})\n        process.Continue()\n        database, thread = entry('BEGIN IMMEDIATE;')\n        if config['mode'] == 'BEFORE_BEGIN':\n            kill_owned(config['mode'])\n        else:\n            leave(thread, 'BEGIN IMMEDIATE;')\n            process.Continue()\n            same_database, thread = entry('COMMIT;', database)\n            assert same_database == database\n            if config['mode'] == 'INSIDE_TRANSACTION_BEFORE_COMMIT':\n                kill_owned(config['mode'])\n            else:\n                leave(thread, 'COMMIT;')\n                if config['mode'] == 'AFTER_COMMIT_BEFORE_RESPONSE':\n                    kill_owned(config['mode'])\n                else:\n                    target.DeleteAllBreakpoints()\n                    detached = process.Detach()\n                    assert detached.Success(), str(detached)\n                    event('DETACHED', pid=config['pid'])\n        status = 'CALIBRATION_CONFIRMED' if config['mode'] == 'CALIBRATION_ONLY' else 'FAULT_INJECTED_NOT_ACCEPTANCE'\n    except Exception as error:\n        error_text = str(error)\n        event('DRIVER_FAILURE', message=error_text)\n        result.SetError(error_text)\n    finally:\n        if process and process.IsValid() and not killed and process.GetState() not in [lldb.eStateDetached, lldb.eStateExited, lldb.eStateInvalid]:\n            if target:\n                target.DeleteAllBreakpoints()\n            cleanup = process.Detach()\n            event('FINALLY_DETACH', succeeded=cleanup.Success())\n            if not cleanup.Success():\n                status = 'CLEANUP_FAILED'\n        write_new(os.path.join(root, 'DEBUGGER-RESULT.json'), {'schema': 'runtime-owned-sqlite-fault-result/v1', 'mode': config['mode'], 'status': status, 'pid': config['pid'], 'killed': killed, 'error': error_text, 'events': events, 'productAcceptanceCredit': 0})\n\n\ndef __lldb_init_module(debugger, internal_dict):\n    debugger.HandleCommand('command script add -f sqlite_fault_driver.run cv04-run')\n";

// Original fixed E13.CV04 installed-service fault collector. These controlled
// faults are isolated acceptance operations, never a product fault API.
const cv04Points=['BEFORE_BEGIN','INSIDE_TRANSACTION_BEFORE_COMMIT','AFTER_COMMIT_BEFORE_RESPONSE'];
const faultSha=bytes=>createHash('sha256').update(bytes).digest('hex');
function faultPrivate(ref,limit=1048576){
 assert.equal(fs.realpathSync(ref),ref);const s=fs.lstatSync(ref);
 assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o777)===0o600&&s.size<=limit);
 return fs.readFileSync(ref);
}
async function faultWait(promise,milliseconds,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),milliseconds);})]);}finally{clearTimeout(timer);}}
const faultSleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function activationAtomicity(run,driver,c,plan){
 exactKeys(plan,['instanceId','allowServiceRestart','transactionFault']);slug(plan.instanceId);assert.equal(plan.allowServiceRestart,true);
 const cfg=plan.transactionFault;exactKeys(cfg,['debuggerExecutable','debuggerSha256','timeoutMs','points','serviceSelection','syntheticTechnicalFaultOnly']);
 assert.equal(cfg.debuggerExecutable,'/usr/bin/lldb');assert.equal(cfg.timeoutMs,45000);assert.deepEqual(cfg.points,cv04Points);assert.equal(cfg.syntheticTechnicalFaultOnly,true);
 const executable=fs.realpathSync(cfg.debuggerExecutable),debuggerStat=fs.statSync(executable);assert(debuggerStat.isFile()&&(debuggerStat.mode&0o022)===0&&(debuggerStat.mode&0o111)!==0);assert.equal(faultSha(fs.readFileSync(executable)),cfg.debuggerSha256);
 exactKeys(cfg.serviceSelection,['ref','sha256']);const selectionBytes=faultPrivate(cfg.serviceSelection.ref);assert.equal(faultSha(selectionBytes),cfg.serviceSelection.sha256);
 const selected=JSON.parse(selectionBytes),installPlan=JSON.parse(faultPrivate(path.join(run.selection.installedRoot,'installation-plan.json')));
 assert.equal(installPlan.codex,null);assert.equal(installPlan.nodeExecutable,'/usr/local/bin/node');assert.equal(process.version,'v24.14.0');assert.equal(process.arch,'arm64');assert.equal(process.platform,'darwin');
 const control=await import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist/installation/service-control.js')).href),inspection=await import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist/installation/service-upgrade.js')).href);
 const exactSelection=()=>{const current=control.inspectInstalledServiceSelection(run.selection.installedRoot);assert.deepEqual(current,selected);assert.equal(current.serviceId,run.candidate.serviceId);assert.equal(current.distributionManifestDigest,run.selection.expectedManifestDigest);return current;};
 async function operate(operation){const result=await control.operateInstalledService(exactSelection(),operation);run.artifact('transaction-native-service-control.json',{operation,result});return result;}
 async function inventory(label){
  await operate('stop');const result=await inspection.inspectServiceUpgradeSource(exactSelection());
  assert.equal(result.snapshot.serviceId,run.candidate.serviceId);assert.equal(result.snapshot.authority,false);assert.equal(result.snapshot.sourceManifestDigest,run.candidateDigest);
  assert.deepEqual(result.snapshot.database.tables.map(v=>v.name).sort(),['audit','events','objects','project_revisions','receipts','service_meta','sqlite_sequence']);
  run.artifact('transaction-native-ledger-inventory.json',{label,result});await operate('start');return result.snapshot;
 }
 let oldClient,newClient,liveDebugger,liveDebuggerDone,attachedPid=null,attachedProcessIdentity=null;
 const initialInstance=(await driver.instance(plan.instanceId)).instance;assert(Object.values(initialInstance.stages).every(v=>v.status==='PENDING'&&v.attempts===0&&v.requestId===null));assert.deepEqual(initialInstance.requestIds,[]);
 const initialView=await run.read('lifecycle.definition.inspect');assert(initialView.active);const originals={};for(const value of [initialView.active,initialView.draft].filter(Boolean))originals[value.id]=await run.source(value.id);
 const browser=await chromium.launch({headless:true});const summaries=[];let primaryFailure=null;
 async function finishDebugger(){
  if(!liveDebugger)return;
  if(liveDebugger.exitCode===null&&liveDebugger.signalCode===null){liveDebugger.kill('SIGTERM');try{await faultWait(liveDebuggerDone,500,'LLDB_STOP_TIMEOUT');}catch{try{process.kill(-liveDebugger.pid,'SIGKILL');}catch{}await faultWait(liveDebuggerDone,1000,'LLDB_KILL_TIMEOUT');}}
  liveDebugger=null;
 }
 try{
  assert.equal((await operate('inspect')).service.running,true);
  for(const point of cv04Points){
   const baselineLedger=await inventory(point+'-before'),before=await run.read('lifecycle.definition.inspect'),baselineEvents=await driver.events(),baselineInstance=(await driver.instance(plan.instanceId)).instance;
   assert.deepEqual(baselineInstance,initialInstance);assert(before.active);
   oldClient=await openBrowser(run,browser);newClient=await openBrowser(run,browser);
   const yaml=(await run.source(before.active.id))+'\n# E13 CV04 '+point+' '+run.selection.runId+'\n';
   await oldClient.source.fill(yaml);await oldClient.preview();await expect(oldClient.page.getByRole('button',{name:'保存并启用',exact:true})).toBeEnabled();await oldClient.flush();await newClient.flush();
   const preview=oldClient.network.findLast(v=>v.request.operation==='lifecycle.definition.validate'&&v.request.input.yaml===yaml&&v.status===200);assert(preview);const validation=JSON.parse(preview.rawBody).result;assert.equal(validation.ready,true);
   const observed=await operate('inspect'),pid=observed.service.pid;assert.equal(observed.service.running,true);assert(Number.isInteger(pid)&&pid>1);
   const processIdentity=execFileSync('/bin/ps',['-p',String(pid),'-o','pid=,lstart=,comm='],{encoding:'utf8',timeout:2000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}}).trim();assert(processIdentity.startsWith(String(pid)));assert(processIdentity.endsWith(installPlan.nodeExecutable));
   attachedPid=pid;attachedProcessIdentity=processIdentity;const dir=path.join(run.selection.outputRoot,'transaction-'+point.toLowerCase().replaceAll('_','-'));fs.mkdirSync(dir,{mode:0o700});for(const name of ['home','tmp'])fs.mkdirSync(path.join(dir,name),{mode:0o700});
   const save=(name,value)=>fs.writeFileSync(path.join(dir,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
   save('sqlite_fault_driver.py',CV04_PYTHON_DRIVER);const identity={kind:'EXACT_INSTALLED_RUNTIME_FAULT',pid,nodeExecutable:installPlan.nodeExecutable,ownedByThisPacket:true,existingService:false,faultExecutionReviewed:true,selectionDigest:selected.selectionDigest,candidateDigest:run.candidateDigest,serviceId:run.candidate.serviceId,processIdentity,syntheticTechnicalFixture:true,domainOrReleaseAuthority:false};save('IDENTITY.json',identity);
   const deadline=Date.now()+cfg.timeoutMs;const input={schema:'runtime-owned-sqlite-fault-driver/v1',mode:point,pid,nodeExecutable:installPlan.nodeExecutable,nodeSha256:installPlan.nodeSha256,root:dir,deadline:new Date(deadline).toISOString(),identityRef:path.join(dir,'IDENTITY.json'),identitySha256:faultSha(faultPrivate(path.join(dir,'IDENTITY.json')))};save('INPUT.json',input);
   save('commands.txt','command script import '+path.join(dir,'sqlite_fault_driver.py')+'\ncv04-run '+path.join(dir,'INPUT.json')+'\nquit\n');
   let stdout='',stderr='',spawnFailure=null,outputOverflow=false;liveDebugger=spawn(executable,['--no-lldbinit','--batch','-s',path.join(dir,'commands.txt')],{cwd:dir,env:{PATH:'/usr/bin:/bin',HOME:path.join(dir,'home'),TMPDIR:path.join(dir,'tmp'),LANG:'en_US.UTF-8'},stdio:['ignore','pipe','pipe'],detached:true});
   const retainOutput=(kind,chunk)=>{const prior=kind==='stdout'?stdout:stderr,next=prior+chunk;if(Buffer.byteLength(next)>1048576){outputOverflow=true;liveDebugger.kill('SIGTERM');return;}if(kind==='stdout')stdout=next;else stderr=next;};
   liveDebugger.stdout.on('data',chunk=>retainOutput('stdout',chunk));liveDebugger.stderr.on('data',chunk=>retainOutput('stderr',chunk));
   liveDebuggerDone=new Promise(resolve=>{liveDebugger.on('error',error=>{spawnFailure=error.code??'SPAWN_FAILED';resolve({code:null,signal:null,error:spawnFailure});});liveDebugger.on('close',(code,signal)=>resolve({code,signal}));});
   let envelope=null,originalRequest=null,transportFailure=null,responseObserved=false,routeFailure=null,submitted=0;
   const onRequestFailed=request=>{if(request===originalRequest)transportFailure={errorText:request.failure()?.errorText??null,at:new Date().toISOString()};};
   const onResponse=response=>{if(response.request()===originalRequest)responseObserved=true;};
   oldClient.page.on('requestfailed',onRequestFailed);oldClient.page.on('response',onResponse);
   try{
    while(!fs.existsSync(path.join(dir,'ARMED.json'))){assert(Date.now()<deadline-5000&&!spawnFailure&&liveDebugger.exitCode===null&&liveDebugger.signalCode===null,'Debugger failed to arm');await faultSleep(25);}
    const armed=JSON.parse(faultPrivate(path.join(dir,'ARMED.json')));assert.equal(armed.pid,pid);assert.equal(armed.mode,point);
    await oldClient.page.route('**/api/v1/dashboard/request',async route=>{
     const value=route.request().postDataJSON();if(value.operation!=='lifecycle.definition.save-and-activate')return route.continue();
     try{assert.equal(++submitted,1);envelope=value;originalRequest=route.request();exactKeys(envelope,['operation','projectId','input','requestId','expectedRevision']);assert.equal(envelope.projectId,run.selection.projectId);assert.equal(envelope.input.yaml,yaml);assert.equal(envelope.input.validationDigest,validation.validationDigest);assert.equal(envelope.expectedRevision,before.revision);await noReceipt(run,envelope.requestId);save('ORIGINAL-REQUEST.json',{envelope,bodySha256:faultSha(JSON.stringify(envelope)),armedAt:armed.at,submittedAt:new Date().toISOString(),noResponseFulfillment:true});await route.continue();}catch(error){routeFailure=error;await route.abort();}
    });
    await oldClient.step('Submit exact activation into controlled '+point+' service-process fault',async()=>{
     await oldClient.page.getByRole('button',{name:'保存并启用',exact:true}).click();
     const exited=await faultWait(liveDebuggerDone,Math.max(1,deadline-Date.now()),'FIXED_FAULT_INJECTION_TIMEOUT');assert.equal(outputOverflow,false,'Bounded debugger output exceeded the fixed limit');assert.equal(exited.code,0);assert.equal(exited.signal,null);if(routeFailure)throw routeFailure;assert.equal(submitted,1);assert(envelope);
     const debug=JSON.parse(faultPrivate(path.join(dir,'DEBUGGER-RESULT.json')));assert.equal(debug.status,'FAULT_INJECTED_NOT_ACCEPTANCE');assert.equal(debug.mode,point);assert.equal(debug.pid,pid);assert.equal(debug.killed,true);assert.equal(debug.error,null);
     const kinds=debug.events.map(v=>v.kind);assert.deepEqual(kinds,['ATTACHED_AND_ARMED','PROCESS_IDENTITY_VERIFIED','SQL_ENTRY',...(point==='BEFORE_BEGIN'?[]:['SQL_RETURN','SQL_ENTRY']),...(point==='AFTER_COMMIT_BEFORE_RESPONSE'?['SQL_RETURN']:[]),'PROCESS_IDENTITY_VERIFIED','OWNED_SIGKILL']);const identities=debug.events.filter(v=>v.kind==='PROCESS_IDENTITY_VERIFIED');assert.deepEqual(identities.map(v=>v.phase),['AFTER_ATTACH','BEFORE_SIGKILL']);for(const value of identities){assert.equal(value.pid,pid);assert.equal(value.processIdentity,processIdentity);}
     const entries=debug.events.filter(v=>v.kind==='SQL_ENTRY');assert.equal(entries[0].sql,'BEGIN IMMEDIATE;');if(entries.length===2){assert.equal(entries[1].sql,'COMMIT;');assert.equal(entries[0].databasePointer,entries[1].databasePointer);}for(const row of debug.events.filter(v=>v.kind==='SQL_RETURN'))assert.equal(row.sqliteCode,0);
     while(!transportFailure){assert(Date.now()<deadline,'Original HTTP transport did not terminate after process SIGKILL');await faultSleep(25);}assert.equal(responseObserved,false,'This is before response, not a post-response socket cancellation');assert(transportFailure.errorText);
     run.artifact('transaction-debugger-observation.json',{point,input,identity,armed,debug,debuggerExit:exited,driverSha256:faultSha(CV04_PYTHON_DRIVER),stdout,stderr,originalRequest:envelope,transportFailure,responseObserved});
    });
   }finally{
    save('LLDB-STDOUT.log',stdout);save('LLDB-STDERR.log',stderr);
    const debuggerResultRef=path.join(dir,'DEBUGGER-RESULT.json'),debuggerResultBytes=fs.existsSync(debuggerResultRef)?faultPrivate(debuggerResultRef):null;
    run.artifact('transaction-debugger-original-final.json',{point,input,identity,driverSha256:faultSha(CV04_PYTHON_DRIVER),stdout,stderr,rawDebuggerResult:debuggerResultBytes?.toString()??null,rawDebuggerResultSha256:debuggerResultBytes?faultSha(debuggerResultBytes):null,semanticAssertionsMayHaveFailed:true});
    if(envelope)run.artifact('transaction-original-http-outcome.json',{point,envelope,submitted,responseObserved,transportFailure,routeFailure:routeFailure?{name:routeFailure.name,message:routeFailure.message}:null});
    await oldClient.page.unroute('**/api/v1/dashboard/request');oldClient.page.off('requestfailed',onRequestFailed);oldClient.page.off('response',onResponse);await finishDebugger();
   }
   const crashed=await operate('inspect');assert.equal(crashed.service.running,false);assert.equal(crashed.service.pid,null);assert.equal(crashed.service.registered,true);attachedPid=null;
   await operate('start');const recoveredLedger=await inventory(point+'-after-crash-recovery'),after=await run.read('lifecycle.definition.inspect');
   assert.equal(recoveredLedger.database.schemaDigest,baselineLedger.database.schemaDigest);
   let receipt;
   if(point==='AFTER_COMMIT_BEFORE_RESPONSE'){
    receipt=await run.read('runtime.receipt.read',{requestId:envelope.requestId});assert.equal(receipt.result.status,'ACTIVE');assert.equal(after.revision,before.revision+1);assert.equal(after.active.id,receipt.result.revisionId);assert.equal(after.draft.id,receipt.result.revisionId);
    for(const name of ['audit','events','receipts'])assert.equal(recoveredLedger.database.tables.find(t=>t.name===name).rows,baselineLedger.database.tables.find(t=>t.name===name).rows+1);
    assert.equal(recoveredLedger.database.tables.find(t=>t.name==='objects').rows,baselineLedger.database.tables.find(t=>t.name==='objects').rows+1);
    assert.equal(recoveredLedger.database.tables.find(t=>t.name==='project_revisions').rows,baselineLedger.database.tables.find(t=>t.name==='project_revisions').rows);
    assert.equal(recoveredLedger.database.tables.find(t=>t.name==='sqlite_sequence').rows,baselineLedger.database.tables.find(t=>t.name==='sqlite_sequence').rows);
    assert.deepEqual(recoveredLedger.database.tables.find(t=>t.name==='service_meta'),baselineLedger.database.tables.find(t=>t.name==='service_meta'));
    const recordKey=value=>JSON.stringify([value.projectId,value.kind,value.id]),oldRecords=new Map(baselineLedger.historicalRecords.map(value=>[recordKey(value),value])),recoveredRecords=new Map(recoveredLedger.historicalRecords.map(value=>[recordKey(value),value]));
    assert.equal(oldRecords.size,baselineLedger.historicalRecords.length);assert.equal(recoveredRecords.size,recoveredLedger.historicalRecords.length);assert.equal(recoveredRecords.size,oldRecords.size+1);
    for(const [key,value]of oldRecords)assert.deepEqual(recoveredRecords.get(key),value,'Every original historical record and its exact value digest must survive the committed activation');
    const addedRecords=[...recoveredRecords].filter(([key])=>!oldRecords.has(key)).map(([,value])=>value);assert.equal(addedRecords.length,1);assert.equal(addedRecords[0].projectId,run.selection.projectId);assert.equal(addedRecords[0].kind,'definition-revision');assert.equal(addedRecords[0].id,receipt.result.revisionId);
   }else{assert.deepEqual(recoveredLedger.database,baselineLedger.database);assert.deepEqual(recoveredLedger.historicalRecords,baselineLedger.historicalRecords);assert.deepEqual(after,before);await noReceipt(run,envelope.requestId);}
   const retry=await run.request(envelope.operation,envelope.input,{requestId:envelope.requestId,expectedRevision:envelope.expectedRevision});assert.equal(retry.status,200);if(receipt)assert.deepEqual(retry.body.result,receipt);else receipt=retry.body.result;
   assert.equal(receipt.requestId,envelope.requestId);assert.equal(receipt.operation,envelope.operation);assert.equal(receipt.result.status,'ACTIVE');assert.equal(receipt.result.executionAuthorized,false);assert.equal(receipt.result.releaseAuthorized,false);
   const replay=await run.request(envelope.operation,envelope.input,{requestId:envelope.requestId,expectedRevision:envelope.expectedRevision});assert.equal(replay.status,200);assert.deepEqual(replay.body.result,receipt);
   const changed=await run.request(envelope.operation,{...envelope.input,yaml:yaml+'# same-key changed content\n'},{requestId:envelope.requestId,expectedRevision:envelope.expectedRevision});assert.equal(changed.status,409);assert.equal(changed.body.error?.code,'REQUEST_CONFLICT');
   const finalView=await run.read('lifecycle.definition.inspect');assert.equal(finalView.revision,before.revision+1);assert.equal(finalView.active.id,receipt.result.revisionId);assert.equal(finalView.draft.id,receipt.result.revisionId);assert.equal(await run.source(finalView.active.id),yaml);
   const finalEvents=await driver.events();assert.deepEqual(finalEvents.slice(0,baselineEvents.length),baselineEvents);const added=finalEvents.slice(baselineEvents.length);assert.equal(added.length,1);assert.equal(added[0].type,'definition-activated');assert.equal(added[0].data.revisionId,receipt.result.revisionId);assert.equal(added[0].revision,receipt.revision);assert.equal(added[0].seq,(baselineEvents.at(-1)?.seq??0)+1);assert.equal(added[0].data.executionAuthorized,false);assert.equal(added[0].data.releaseAuthorized,false);
   assert.deepEqual((await driver.instance(plan.instanceId)).instance,initialInstance);for(const [id,source]of Object.entries(originals))assert.equal(await run.source(id),source);
   // The existing client reconnects through its original page/context. A fresh
   // second client then independently reads the same durable result.
   await newClient.close();newClient=null;await oldClient.login('/lifecycle');newClient=await openBrowser(run,browser);
   for(const ui of [oldClient,newClient]){await expect(ui.source).toHaveValue(yaml);const value=await ui.sessionRequest('lifecycle.definition.inspect');assert.equal(value.status,200);assert.deepEqual(value.body.result,finalView);const original=await ui.sessionRequest('runtime.receipt.read',{requestId:envelope.requestId});assert.equal(original.status,200);assert.deepEqual(original.body.result,receipt);await ui.flush();}
   summaries.push({point,requestId:envelope.requestId,receipt,originalRevision:before.revision,currentRevision:finalView.revision,activationEvents:1,priorLedgerRolledBack:point!=='AFTER_COMMIT_BEFORE_RESPONSE',sameKeySameResult:true,sameKeyChangedContentRejected:true,actualProcessSigkill:true,actualNativeRestart:true,bothClientsReadSameActive:true,historicalInstanceUnchanged:true,stagesDispatched:0});
   run.artifact('transaction-fault-case-point.json',summaries.at(-1));await oldClient.close();oldClient=null;await newClient.close();newClient=null;
  }
  assert.equal(faultSha(fs.readFileSync(executable)),cfg.debuggerSha256);assert.equal(faultSha(faultPrivate(cfg.serviceSelection.ref)),cfg.serviceSelection.sha256);exactSelection();
  return{actualInstalledFaultPoints:summaries.map(v=>v.point),allThreeNativeProcessFaults:true,twoActualBrowserClients:true,originalReceiptsRecovered:true,threeSingleActivations:true,immutableHistoricalInstance:true,stagesDispatched:0,sourceOrDatabasePatched:false,productFaultApiAdded:false};
 }catch(error){primaryFailure=error;throw error;}finally{
  const failures=[];try{await finishDebugger();}catch(error){failures.push(error);}
  if(attachedPid){
   let currentIdentity=null;try{currentIdentity=execFileSync('/bin/ps',['-p',String(attachedPid),'-o','pid=,lstart=,comm='],{encoding:'utf8',timeout:2000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}}).trim();}catch(error){if(error.status!==1)failures.push(error);}
   if(currentIdentity&&currentIdentity===attachedProcessIdentity){try{process.kill(attachedPid,'SIGCONT');run.artifact('transaction-owned-failure-resume.json',{pid:attachedPid,signal:'SIGCONT',sameProcessStartIdentity:true,reason:'Allow native cleanup after failed debugger; no redispatch'});}catch(error){if(error.code!=='ESRCH')failures.push(error);}}
   else run.artifact('transaction-owned-failure-no-signal.json',{originalPid:attachedPid,currentPidIdentityMatches:false,originalProcessGoneOrReplaced:true,signalSent:false});
  }
  for(const ui of [oldClient,newClient])if(ui)try{await ui.close();}catch(error){failures.push(error);}
  try{await browser.close();}catch(error){failures.push(error);}
  try{await operate('stop');const final=await operate('inspect');assert.equal(final.service.running,false);assert.equal(final.service.registered,false);}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError([...(primaryFailure?[primaryFailure]:[]),...failures],'CV04 original cleanup incomplete; retain original failures');
 }
}

test('E13 installed interruption and truthful unavailable measurement branches',{timeout:240000},async t=>{
 const captured=await openScenario('E13'),run={...captured};
 // A bounded request already in flight retains its original response through
 // support. If the test was aborted meanwhile, stop before issuing any next
 // read/write; never interpret cancellation as permission to replay.
 for(const method of ['request','read'])run[method]=async(...args)=>{t.signal.throwIfAborted();const value=await captured[method](...args);t.signal.throwIfAborted();return value;};
 try{
  const fixture=interruptionFixture(run),driver=await openExecution(run,t.signal),used=new Set();
  for(const c of run.cases)await run.collect(c,async()=>{
   if(unsupported[c.caseInstanceId])throw Error('UNIMPLEMENTED_ORIGINAL_CASE: '+unsupported[c.caseInstanceId]);
   const plan=fixture.casePlans[c.caseInstanceId];assert(plan,'A fixed case requires its exact native fixture selection');
   if(c.caseInstanceId==='E13.CV04')return activationAtomicity(run,driver,c,plan);
   if(['E13.variant.07','E13.MC04'].includes(c.caseInstanceId))return definitionConflict(run,driver,c,plan);
   if(['E13.variant.01','E13.variant.02'].includes(c.caseInstanceId)){assert(!used.has(plan.instanceId),'Interruption cases require independent original instances');used.add(plan.instanceId);return interruption(run,driver,c,plan);}
   if(c.caseInstanceId==='E13.variant.06')return unsupportedLimit(run,driver,c,plan);
   throw Error('UNIMPLEMENTED_ORIGINAL_CASE: '+c.caseInstanceId);
  });
 }finally{run.finish();}
});
