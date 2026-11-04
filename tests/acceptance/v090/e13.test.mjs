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
// 05 independently reads the exact real Host report, original token/context and
// tool bytes, original native readbacks and current task attribution. Shared
// thread counters stay known; task nulls need real scope limits, never omission.
// 06 rejects an unsupported exact token cap through the native preview schema;
// it does not add token-budget semantics to Runtime's reporting addendum.
//
// interruptionFixture: {ref,sha256} -> runtime-v090-interruption-fixture/v1:
// {schema,candidateDigest,workspaceId,projectId,syntheticAssets:true,
//  syntheticDecisions:true,casePlans:{[fixedCaseId]:plan}}.
// 01/02 plan={instanceId,allowServiceRestart:true}; use distinct instances.
// 05 plan={instanceId,stageRequestId,reportDigest,hostAvailabilityEvidence:{ref,sha256},codingHostEvidence:{ref,sha256}}.
// 06 plan={instanceId,targetVersion}.
// 07/MC04 plan={}; each runs new actual browser conflicts and one activation.
// A fixture is selection, never a supplied expected outcome or new authority.
const unsupported={
 'E13.journey':'Full original Host, provider-channel interruption, cancellation and managed-action budget journey is not yet implemented.',
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

// Private source reader and original Host proof verifier for variant 05.
const MAX=8*1024*1024,KEYS=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const METRICS=['input','output','total','cachedInput','cacheWriteInput','reasoningOutput'];
// White-list the observed pinned Host profile. Values outside the few fields
// projected below (including nested instructions) are never retained.
const CONTEXT_KEYS=['active_permission_profile','approval_policy','approvals_reviewer','collaboration_mode','comp_hash','cwd','cyber_access_program','disabled_plugin_ids','effort','model','model_provider','multi_agent_version','permission_profile','realtime_active','root_turn_id','sandbox_policy','summary','turn_id'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
const requireThat=(value,code)=>{if(!value)fail(code);};
const exact=(v,keys,code='MEASUREMENT_FIELDS')=>requireThat(v&&typeof v==='object'&&!Array.isArray(v)&&canonical(Object.keys(v).sort())===canonical([...keys].sort()),code);
function privateBytes(ref,max=MAX){
 requireThat(path.isAbsolute(ref)&&fs.realpathSync(ref)===ref,'MEASUREMENT_UNSAFE_FILE');const s=fs.lstatSync(ref);
 requireThat(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o777)===0o600&&s.size<=max,'MEASUREMENT_UNSAFE_FILE');return fs.readFileSync(ref);
}
function readAt(fd,offset,length){const b=Buffer.alloc(length);let got=0;while(got<length){const n=fs.readSync(fd,b,got,length-got,offset+got);requireThat(n>0,'MEASUREMENT_SOURCE_SHORT_READ');got+=n;}return b;}
function counter(v){
 requireThat(v&&typeof v==='object'&&!Array.isArray(v),'MEASUREMENT_SOURCE_PROFILE_CHANGED');
 requireThat(Object.keys(v).every(k=>KEYS.includes(k)),'MEASUREMENT_SOURCE_PROFILE_CHANGED');
 for(const n of Object.values(v))requireThat(n===null||Number.isSafeInteger(n)&&n>=0,'MEASUREMENT_SOURCE_COUNTER');
 // Host counters are independently reported values. Preserve a real total
 // even when it differs from input + output; never normalize or attribute it.
 return structuredClone(v); // Missing and known zero remain distinguishable.
}
const safeName=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(v);

/** Read only selected raw metadata and token rows. Other content is neither
 * parsed nor copied. cutoffBytes is used by offline verification, never allowed
 * beyond actual bytes or in a partial line. No task totals are derived. */
function inspectHostSource(receipt,cutoffBytes,contextPin,invocation){
 const source=receipt.selection.rolloutRef;requireThat(path.isAbsolute(source)&&fs.realpathSync(source)===source&&source.endsWith('.jsonl'),'MEASUREMENT_SOURCE_IDENTITY');
 const st=fs.lstatSync(source);requireThat(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o022)===0&&st.size<=512*1024*1024,'MEASUREMENT_SOURCE_IDENTITY');
 requireThat(st.dev===receipt.device&&st.ino===receipt.inode,'MEASUREMENT_SOURCE_IDENTITY');
 const fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),observedAt=new Date().toISOString();let actualReadBytes=0;
 const take=(offset,length)=>{requireThat(Number.isSafeInteger(length)&&length>=0&&actualReadBytes+length<=MAX,'MEASUREMENT_SOURCE_READ_LIMIT');actualReadBytes+=length;return readAt(fd,offset,length);};
 try{
  const opened=fs.fstatSync(fd);requireThat(opened.dev===st.dev&&opened.ino===st.ino,'MEASUREMENT_SOURCE_IDENTITY');
  requireThat(Number.isSafeInteger(receipt.metaBytes)&&receipt.metaBytes>0&&receipt.metaBytes<=1024*1024,'MEASUREMENT_METADATA_BOUND');
  const metaRaw=take(0,receipt.metaBytes);requireThat(sha(metaRaw)===receipt.metaSha256,'MEASUREMENT_SOURCE_IDENTITY');
  const meta=JSON.parse(metaRaw);requireThat(meta.type==='session_meta','MEASUREMENT_SOURCE_PROFILE_CHANGED');
  const identity={sessionId:meta.payload.id,hostVersion:meta.payload.cli_version,provider:meta.payload.model_provider??null};
  requireThat(identity.sessionId===receipt.metadata.sessionId&&identity.hostVersion===receipt.metadata.hostVersion&&identity.provider===receipt.metadata.provider,'MEASUREMENT_SOURCE_IDENTITY');
  requireThat(identity.hostVersion==='0.166.0-alpha.5.1'&&safeName(identity.provider),'MEASUREMENT_SOURCE_PROFILE_CHANGED');
  let end=cutoffBytes;
  if(end===undefined){if(take(opened.size-1,1)[0]===10)end=opened.size;else{const tailStart=Math.max(receipt.startOffset,opened.size-65536),tail=take(tailStart,opened.size-tailStart),newline=tail.lastIndexOf(10);requireThat(newline>=0,'MEASUREMENT_SOURCE_NO_COMPLETE_CUTOFF');end=tailStart+newline+1;}}
  exact(contextPin,['offset','bytes','sha256'],'MEASUREMENT_CONTEXT_PIN');
  requireThat(Number.isSafeInteger(contextPin.offset)&&contextPin.offset>=receipt.metaBytes&&Number.isSafeInteger(contextPin.bytes)&&contextPin.bytes>0&&contextPin.bytes<=1024*1024&&/^[a-f0-9]{64}$/.test(contextPin.sha256)&&contextPin.offset+contextPin.bytes<=receipt.startOffset,'MEASUREMENT_CONTEXT_PIN');
  requireThat(Number.isSafeInteger(end)&&end<=opened.size&&end>=receipt.startOffset&&end-receipt.startOffset<=MAX,'MEASUREMENT_SOURCE_CUTOFF');
  requireThat(take(end-1,1)[0]===10&&take(receipt.startOffset-1,1)[0]===10,'MEASUREMENT_SOURCE_CUTOFF');
  requireThat(take(contextPin.offset-1,1)[0]===10,'MEASUREMENT_CONTEXT_PIN');
  const contextRaw=take(contextPin.offset,contextPin.bytes);requireThat(sha(contextRaw)===contextPin.sha256&&contextRaw.at(-1)===10&&contextRaw.subarray(0,-1).indexOf(10)===-1,'MEASUREMENT_CONTEXT_PIN');
  function contextValue(row,pin){
   requireThat(row.type==='turn_context'&&safeName(row.payload.model)&&typeof row.payload.turn_id==='string','MEASUREMENT_MODEL_UNAVAILABLE');
   requireThat(!Object.keys(row.payload).some(k=>/^(task_?id|stage_?request_?id|instance_?id|claim_?digest|cost|amount|currency|total_?cost)$/i.test(k)),'MEASUREMENT_CONTEXT_ATTRIBUTION_PRESENT');
   requireThat(Object.keys(row.payload).every(k=>CONTEXT_KEYS.includes(k)),'MEASUREMENT_SOURCE_PROFILE_CHANGED');
   requireThat(typeof row.timestamp==='string'&&Number.isFinite(Date.parse(row.timestamp))&&Date.parse(row.timestamp)<=Date.parse(observedAt)+1000,'MEASUREMENT_FUTURE_OBSERVATION');
   const provider=row.payload.model_provider??identity.provider;requireThat(safeName(provider),'MEASUREMENT_MODEL_UNAVAILABLE');
   return{rawPin:pin,turnId:row.payload.turn_id,model:row.payload.model,provider};
  }
  const fixed=JSON.parse(contextRaw);requireThat(canonical(Object.keys(fixed).filter(k=>k!=='ordinal').sort())===canonical(['payload','timestamp','type']),'MEASUREMENT_SOURCE_PROFILE_CHANGED');
  const start=receipt.startOffset,raw=take(start,end-start);let local=0,latestContext=contextValue(fixed,contextPin);
  const events=[],contexts=[latestContext],calls=[];
  requireThat(invocation&&typeof invocation.command==='string'&&typeof invocation.workdir==='string'&&typeof invocation.driverRef==='string','MEASUREMENT_INVOCATION_REQUIRED');
  while(local<raw.length){
   const next=raw.indexOf(10,local);requireThat(next>=0,'MEASUREMENT_SOURCE_CUTOFF');const line=raw.subarray(local,next+1),offset=start+local;local=next+1;
   // Inspect only the first two structural type names. In particular, an
   // agent_reasoning/response_item body containing example JSON is not parsed.
   const types=[...line.subarray(0,512).toString().matchAll(/"type"\s*:\s*"([a-z_]+)"/g)].map(v=>v[1]);
   const context=types[0]==='turn_context',token=types[0]==='event_msg'&&types[1]==='token_count',tool=types[0]==='response_item'&&types[1]==='custom_tool_call'&&line.includes(Buffer.from(invocation.driverRef));if(!context&&!token&&!tool)continue;
   requireThat(line.length<=1024*1024,'MEASUREMENT_SOURCE_ROW_LIMIT');const row=JSON.parse(line),pin={offset,bytes:line.length,sha256:sha(line)};
   if(tool){
    if(row.payload?.type!=='custom_tool_call'||row.payload.name!=='exec')continue;const input=row.payload.input?.trim(),prefix='text(await tools.exec_command(';
    if(typeof input!=='string'||!input.startsWith(prefix)||!input.endsWith('));'))continue;
    let args;try{args=JSON.parse(input.slice(prefix.length,-3));}catch{continue;}
    if(args.cmd!==invocation.command||args.workdir!==invocation.workdir)continue;
    const turnId=row.payload.internal_chat_message_metadata_passthrough?.turn_id;requireThat(turnId===latestContext.turnId,'MEASUREMENT_TOOL_TURN_MISMATCH');
    calls.push({rawPin:pin,turnId,callId:row.payload.call_id,contextPin:latestContext.rawPin});continue;
   }
   const topKeys=Object.keys(row).filter(k=>k!=='ordinal');requireThat(canonical(topKeys.sort())===canonical(['payload','timestamp','type']),'MEASUREMENT_SOURCE_PROFILE_CHANGED');
   if(context){
    latestContext=contextValue(row,pin);contexts.push(latestContext);continue;
   }
   if(offset<receipt.startOffset)continue;
   requireThat(row.type==='event_msg'&&row.payload?.type==='token_count','MEASUREMENT_SOURCE_PROFILE_CHANGED');
   const p=row.payload;exact(p,['type','info','rate_limits'],'MEASUREMENT_SOURCE_PROFILE_CHANGED');exact(p.info,['total_token_usage','last_token_usage','model_context_window'],'MEASUREMENT_SOURCE_PROFILE_CHANGED');
   requireThat(typeof row.timestamp==='string'&&Number.isFinite(Date.parse(row.timestamp))&&Date.parse(row.timestamp)<=Date.parse(observedAt)+1000,'MEASUREMENT_FUTURE_OBSERVATION');
   events.push({rawPin:pin,ordinal:row.ordinal??null,timestamp:row.timestamp,contextPin:latestContext?.rawPin??null,total:counter(p.info.total_token_usage),last:counter(p.info.last_token_usage),payloadKeys:Object.keys(p).sort(),infoKeys:Object.keys(p.info).sort(),accountRateLimitsExcluded:true});
  }
  requireThat(events.length>0&&events.length<=10000&&latestContext!==null,'MEASUREMENT_NO_ORIGINAL_OBSERVATIONS');
  requireThat(calls.length===1&&calls[0].turnId===latestContext.turnId,'MEASUREMENT_INVOCATION_NOT_EXACT');
  requireThat(events.every(e=>e.contextPin!==null),'MEASUREMENT_MODEL_UNAVAILABLE');
  requireThat(events.some(e=>Object.values(e.total).some(v=>Number.isSafeInteger(v))),'MEASUREMENT_NO_KNOWN_COUNTERS');
  const after=fs.fstatSync(fd);requireThat(after.dev===opened.dev&&after.ino===opened.ino&&after.size>=end,'MEASUREMENT_SOURCE_IDENTITY');
  requireThat(sha(take(start,end-start))===sha(raw)&&sha(take(0,receipt.metaBytes))===receipt.metaSha256&&sha(take(contextPin.offset,contextPin.bytes))===contextPin.sha256,'MEASUREMENT_SOURCE_CHANGED');
  return{source:{reference:source,device:opened.dev,inode:opened.ino,metadata:{rawPin:{offset:0,bytes:receipt.metaBytes,sha256:receipt.metaSha256},...identity}},range:{contextPin,startOffset:receipt.startOffset,endOffset:end,actualReadBytes,maximumReadBytes:MAX,sourceSizeAtCapture:opened.size,observedAt,sha256:sha(raw)},invocation:calls[0],model:{provider:latestContext.provider,model:latestContext.model,turnId:latestContext.turnId,rawPin:latestContext.rawPin},contexts,tokenEvents:events,cost:{value:null,reason:'NOT_PROVIDED_IN_SELECTED_SOURCE',checkedFields:['token_count top-level row','event_msg.token_count.payload','event_msg.token_count.payload.info','total_token_usage','last_token_usage'],accountRateLimitsNotTaskCost:true},threadCountersKnown:true,independentTaskCountersProvided:false,containsReasoningOrInstructions:false};
 }finally{fs.closeSync(fd);}
}

/** All called operation names/input shapes are the current native read API.
 * Empty output is never accepted as a successful native response. */
async function inspectTaskAttribution({request,serviceId,workspaceId,projectId,handoff}){
 const reads=[];
 async function read(operation,input={}){const response=await request(operation,input);requireThat(response&&typeof response==='object'&&Object.hasOwn(response,'result')&&!response.error,'MEASUREMENT_NATIVE_READ_UNKNOWN');const result=response.result;requireThat(result&&typeof result==='object'&&Buffer.byteLength(JSON.stringify(result))<=1024*1024,'MEASUREMENT_NATIVE_READ_UNKNOWN');reads.push({operation,input,result,resultDigest:'sha256:'+sha(canonical(result))});return result;}
 function status(s){requireThat(s.serviceId===serviceId&&s.workspaceId===workspaceId&&s.projectId===projectId&&Number.isSafeInteger(s.revision),'MEASUREMENT_NATIVE_SCOPE');}
 const before=await read('runtime.status');status(before);
 const inspected=await read('lifecycle.instance.inspect',{instanceId:handoff.instanceId}),instance=inspected.instance;
 requireThat(instance?.id===handoff.instanceId&&instance.pins?.projectId===projectId&&instance.pins.targetRef===handoff.preparationRef&&instance.stages?.implementation?.requestId===handoff.stageRequestId,'MEASUREMENT_NATIVE_SCOPE');
 requireThat(typeof instance.pinsDigest==='string'&&instance.pinsDigest.startsWith('sha256:'),'MEASUREMENT_NATIVE_SCOPE');
 async function pages(operation,key){let after,seen=new Set(),all=[];for(let n=0;n<20;n++){const v=await read(operation,after===undefined?{}:{after});requireThat(Array.isArray(v[key])&&v[key].length<=50&&Object.hasOwn(v,'nextAfter'),'MEASUREMENT_NATIVE_PAGE');all.push(...v[key]);if(v.nextAfter===null)return all;requireThat(typeof v.nextAfter==='string'&&v.nextAfter.length>0&&!seen.has(v.nextAfter)&&v[key].length===50,'MEASUREMENT_NATIVE_PAGE');seen.add(v.nextAfter);after=v.nextAfter;}fail('MEASUREMENT_NATIVE_PAGE_LIMIT');}
 const sources=await pages('usage.sources.list','sources'),bindings=await pages('usage.attributions.list','bindings');
 for(const s of sources)requireThat(s?.projectId===projectId&&typeof s.id==='string','MEASUREMENT_NATIVE_SCOPE');
 for(const item of bindings){const b=item?.binding;requireThat(b&&b.projectId===projectId&&typeof b.instanceId==='string'&&typeof b.stageId==='string'&&typeof b.targetVersion==='string','MEASUREMENT_NATIVE_READ_UNKNOWN');if(b.instanceId===handoff.instanceId&&b.stageId==='implementation')fail('MEASUREMENT_TASK_ATTRIBUTION_EXISTS');}
 const targetVersion=handoff.preparation?.target?.version;requireThat(typeof targetVersion==='string'&&targetVersion.length>0,'MEASUREMENT_NATIVE_SCOPE');
 const query={targetVersion,instanceId:handoff.instanceId,stageId:'implementation',format:'json'},report=await read('usage.report.read',query);
 requireThat(report.schema==='runtime-token-report/v1'&&report.projectId===projectId&&report.targetVersion===targetVersion&&report.instanceId===handoff.instanceId&&report.stageId==='implementation'&&report.coverage==='REGISTERED_SOURCES_ONLY'&&report.completeVersionTotal===false&&Number.isSafeInteger(report.records)&&Array.isArray(report.sources),'MEASUREMENT_NATIVE_READ_UNKNOWN');
 requireThat(report.records===0&&report.sources.length===0,'MEASUREMENT_TASK_MEASUREMENT_EXISTS');exact(report.counts,METRICS,'MEASUREMENT_NATIVE_READ_UNKNOWN');
 for(const metric of METRICS){const c=report.counts[metric];requireThat(c&&c.recorded===null&&c.unknownRecords===0,'MEASUREMENT_TASK_MEASUREMENT_EXISTS');}
 const after=await read('runtime.status');status(after);requireThat(after.revision===before.revision&&report.cutoffRevision===before.revision,'MEASUREMENT_NATIVE_SCOPE_CHANGED');
 return{instanceId:instance.id,instancePinsDigest:instance.pinsDigest,targetRef:instance.pins.targetRef,targetVersion,ledgerRevision:before.revision,matchingTaskBindings:0,noRegisteredTaskMeasurement:true,emptyReportAloneProvesUnavailability:false,reads};
}

const MEASUREMENT_SUMMARY='已知模型/provider；原始共享聊天 token 计数随来源证据保留。本任务没有可独立核实的 token 归属，因此任务 token 数未提供；所选原始来源没有任务金额/币种，实际费用未提供。观测仅截至本报告前的原事件，不代表整个 stage、turn 或版本总量。';


function pinned(ref,digest,max=262144){const bytes=privateBytes(ref,max);assert.equal(sha(bytes),digest);return bytes;}
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

async function proveMeasurementCodingHost(run,selected,handoff,reported,claim,nodeExecutable,valueDigest,proofPin){
 const ref=proofPin.ref;assert(fs.existsSync(ref),'Original Host proof must already exist; this read-only case never starts or resumes the Host');
 const proofBytes=pinned(ref,proofPin.sha256,1048576),proof=JSON.parse(proofBytes);
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
  return{summary:result,phaseRanges:{propose:{startedAt:proposed.startedAt,completedAt:proposed.completedAt,call:proof.propose.call,output:proof.propose.polls.at(-1)?.output??proof.propose.output,turnId:proposed.turnId},submit:{startedAt:submitted.startedAt,completedAt:submitted.completedAt,call:proof.submit.call,output:proof.submit.polls.at(-1)?.output??proof.submit.output,turnId:submitted.turnId}},revalidate(){
   assert.equal(fs.realpathSync(selected.selection.rolloutRef),selected.selection.rolloutRef);const st=fs.lstatSync(selected.selection.rolloutRef);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o022)===0);assert.equal(st.ino,selected.inode);assert.equal(st.dev,selected.device);
   assert.equal(sha(privateBytes(ref)),sha(proofBytes));assert.equal(sha(privateBytes(selected.selectionRef)),selected.selectionSha256);pinned(selected.selection.driverRef,selected.selection.driverSha256,1048576);
   const source=fs.openSync(selected.selection.rolloutRef,'r');try{const header=Buffer.alloc(selected.metaBytes);assert.equal(fs.readSync(source,header,0,header.length,0),header.length);assert.equal(sha(header),selected.metaSha256);for(const item of records){const raw=Buffer.alloc(item.pin.bytes);assert.equal(fs.readSync(source,raw,0,raw.length,item.pin.offset),raw.length);assert.equal(sha(raw),item.pin.sha256);}}finally{fs.closeSync(source);}
   return{recordCount:records.length,sourceSelectionSha256:selected.selectionSha256,proofSha256:sha(proofBytes),driverSha256:selected.selection.driverSha256,unchanged:true};
  }};
 }finally{fs.closeSync(fd);}
}

// Included only in the private proposed E13 collector. All Runtime operations
// below are reads. No provider calls, Host starts, report or authority writers.
async function unavailableTaskMeasurement(run,driver,c,plan){
 exactKeys(plan,['instanceId','stageRequestId','reportDigest','hostAvailabilityEvidence','codingHostEvidence']);slug(plan.instanceId);
 exactKeys(plan.codingHostEvidence,['ref','sha256']);assert(/^[a-f0-9]{64}$/.test(plan.codingHostEvidence.sha256));assert(/^sha256:[a-f0-9]{64}$/.test(plan.reportDigest));
 const pins=[];
 function pinnedJson(pin,max=8388608){exactKeys(pin,['ref','sha256']);assert(/^[a-f0-9]{64}$/.test(pin.sha256));const raw=privateBytes(pin.ref,max);assert.equal(sha(raw),pin.sha256);pins.push({ref:pin.ref,sha256:pin.sha256});return JSON.parse(raw);}
 function sourceJson(source,max=8388608){exactKeys(source,['reference','digest']);assert(/^sha256:[a-f0-9]{64}$/.test(source.digest));return pinnedJson({ref:source.reference,sha256:source.digest.slice(7)},max);}
 const before=await driver.original(plan.stageRequestId),initial=before.instance;
 assert.equal(initial.id,plan.instanceId);assert.equal(before.request.stageId,'implementation');
 const eventsBefore=await driver.events(),statusBefore=await run.read('runtime.status');
 const handoffRead=await run.read('lifecycle.agent.handoff.read',{stageRequestId:plan.stageRequestId}),handoff=driver.intact(handoffRead.handoff),claim=driver.intact(handoffRead.claim);
 assert.equal(handoffRead.hostSessionAttested,false);assert.equal(handoffRead.softwareReleaseAuthorized,false);assert.equal(handoff.instanceId,initial.id);assert.equal(handoff.preparationRef,initial.pins.targetRef);assert.equal(handoff.stageRequestId,plan.stageRequestId);assert.equal(claim.handoffDigest,handoff.digest);assert.equal(claim.principalId,before.request.initiatedBy.id);assert.equal(claim.principalRevision,before.request.initiatedBy.revision);
 assert.equal(handoffRead.latestReport?.digest,plan.reportDigest,'Select the exact original terminal Host report, not an arbitrary null report');
 const reports=[];let digest=plan.reportDigest;
 for(let n=0;digest!==null;n++){
  assert(n<16,'Keep the actual report chain within this fixed technical profile');
  const read=await run.read('lifecycle.agent.report.read',{stageRequestId:plan.stageRequestId,reportDigest:digest}),report=driver.intact(read.report);
  assert.equal(report.digest,digest);assert.equal(report.claimDigest,claim.digest);assert.equal(report.stageRequestId,plan.stageRequestId);assert.equal(report.independentlyVerified,false);assert.equal(read.independentlyVerified,false);assert.equal(read.authorityGranted,false);assert.equal(read.measurementSource,'host-reported');assert(report.measurement,'Omission is not proof of unavailability');
  assert.equal(report.state,n===0?'SUBMITTED':'WORKING');reports.push(report);digest=report.previousReportDigest;
 }
 const reported=reports[0];assert.deepEqual(handoffRead.latestReport,reported);
 const finalSource=pinnedJson(plan.hostAvailabilityEvidence);
 assert.equal(reported.measurement.source.reference,plan.hostAvailabilityEvidence.ref);assert.equal(reported.measurement.source.digest,'sha256:'+plan.hostAvailabilityEvidence.sha256);
 const selectionBytes=privateBytes(finalSource.sourceSelection.reference,1048576);assert.equal('sha256:'+sha(selectionBytes),finalSource.sourceSelection.digest);pins.push({ref:finalSource.sourceSelection.reference,sha256:sha(selectionBytes)});
 const selected=JSON.parse(selectionBytes),root=selected.selection.preparationRoot;
 assert.equal(selected.selection.driverRef,path.join(root,'current-codex.mjs'));assert.equal(handoff.workspaceRoot,path.join(root,'coding-workspace'));assert.equal(fs.realpathSync(root),root);assert.equal(selected.metadata.hostVersion,claim.host.version);assert.equal(selected.metadata.sessionId,claim.host.sessionId);
 const sourceReceipt=pinnedJson({ref:selected.selectionRef,sha256:selected.selectionSha256},1048576);assert.deepEqual(sourceReceipt,selected.selection);
 const preparationPlanBytes=privateBytes(path.join(root,'PREPARATION-PLAN.json')),preparationPlan=JSON.parse(preparationPlanBytes);pins.push({ref:path.join(root,'PREPARATION-PLAN.json'),sha256:sha(preparationPlanBytes)});
 assert.equal(preparationPlan.candidate.manifestDigest,run.candidateDigest.slice(7));assert.equal(preparationPlan.workspaceId,run.selection.workspaceId);assert.equal(preparationPlan.projectId,run.selection.projectId);assert.equal(preparationPlan.testRelease.version,handoff.preparation.target.version);
 const driverRecipe=preparationPlan.recipes.find(v=>v.ref===selected.selection.driverRef),helperRecipe=preparationPlan.recipes.find(v=>v.ref===path.join(root,'measurement-helper.mjs'));
 assert(driverRecipe&&helperRecipe);assert.equal(driverRecipe.sha256,selected.selection.driverSha256);for(const recipe of [driverRecipe,helperRecipe]){pinnedJsonBytes(recipe);}
 function pinnedJsonBytes(pin){const raw=privateBytes(pin.ref,1048576);assert.equal(sha(raw),pin.sha256);pins.push(pin);return raw;}
 const specification=JSON.parse(privateBytes(path.join(run.selection.installedRoot,'service-specification.json'),1048576));assert.equal(specification.root,run.selection.installedRoot);
 const valueDigest=value=>'sha256:'+sha(canonical(value));
 const coding=await proveMeasurementCodingHost(run,selected,handoff,reported,claim,specification.nodeExecutable,valueDigest,plan.codingHostEvidence);pins.push(plan.codingHostEvidence);
 const originalReadbacks=[],observations=[],sourceChecks=[],phaseCounters=new Map(),sourceReferences=new Set();
 for(const report of [...reports].reverse()){
  const source=sourceJson(report.measurement.source);
  exact(source,['schema','phase','index','candidateDigest','serviceId','workspaceId','projectId','instanceId','instancePinsDigest','targetRef','targetVersion','stageRequestId','handoffDigest','claimDigest','host','sourceSelection','scope','coverage','availability','nativeAttribution','original','hostSessionAttested','independentlyVerified','summary']);
  assert.equal(source.schema,'runtime-real-host-measurement-availability/v1');assert.equal(source.candidateDigest,run.candidateDigest);assert.equal(source.serviceId,run.candidate.serviceId);assert.equal(source.workspaceId,run.selection.workspaceId);assert.equal(source.projectId,run.selection.projectId);assert.equal(source.instanceId,initial.id);assert.equal(source.instancePinsDigest,initial.pinsDigest);assert.equal(source.targetRef,initial.pins.targetRef);assert.equal(source.targetVersion,handoff.preparation.target.version);assert.equal(source.stageRequestId,plan.stageRequestId);assert.equal(source.handoffDigest,handoff.digest);assert.equal(source.claimDigest,claim.digest);
  assert.deepEqual(source.host,{hostId:claim.host.hostId,version:claim.host.version,sessionId:claim.host.sessionId});assert.equal(source.hostSessionAttested,false);assert.equal(source.independentlyVerified,false);assert.equal(source.scope,'SHARED_HOST_SOURCE_OBSERVATION');
  assert.deepEqual(source.coverage,{taskIndependentAttribution:false,completeTaskTotal:false,completeStageTotal:false,completeTurnTotal:false,completeVersionTotal:false,includesFutureEvents:false});assert.deepEqual(source.availability,{provider:'KNOWN',model:'KNOWN',taskTokens:'NO_INDEPENDENT_TASK_ATTRIBUTION_IN_SELECTED_SOURCE',cost:'NOT_PROVIDED_IN_SELECTED_SOURCE'});assert.equal(source.summary,MEASUREMENT_SUMMARY);assert(report.summary.includes(MEASUREMENT_SUMMARY));
  assert.equal(source.phase,report.state==='SUBMITTED'?'submit':'propose');assert(Number.isSafeInteger(source.index)&&source.index>=1&&source.index<=16);const phaseRoot=path.join(root,'current-codex-'+source.phase),stem='MEASUREMENT-'+String(source.index).padStart(4,'0');assert.equal(report.measurement.source.reference,path.join(phaseRoot,stem+'.json'));
  assert.equal(source.index,(phaseCounters.get(source.phase)??0)+1);phaseCounters.set(source.phase,source.index);assert(!sourceReferences.has(report.measurement.source.reference),'Every original report has a separate immutable measurement observation');sourceReferences.add(report.measurement.source.reference);
  assert.deepEqual(source.sourceSelection,finalSource.sourceSelection);assert.deepEqual(source.original.range.contextPin,preparationPlan.originalHost.measurementContextPin);
  const phase=coding.phaseRanges[source.phase];assert(phase);assert(Date.parse(source.original.range.observedAt)>=Date.parse(phase.startedAt)&&Date.parse(source.original.range.observedAt)<=Date.parse(report.receivedAt));assert(source.original.range.endOffset>=phase.call.offset+phase.call.bytes&&source.original.range.endOffset<=phase.output.offset,'The frozen source cutoff must predate this completed original Host phase');
  const original=inspectHostSource(selected,source.original.range.endOffset,source.original.range.contextPin,{command:quote(specification.nodeExecutable)+' '+quote(selected.selection.driverRef)+' '+source.phase,workdir:root,driverRef:selected.selection.driverRef});
  for(const key of ['source','invocation','model','contexts','tokenEvents','cost','threadCountersKnown','independentTaskCountersProvided','containsReasoningOrInstructions'])assert.deepEqual(source.original[key],original[key],key);
  assert.equal(source.original.range.startOffset,selected.startOffset);assert.equal(source.original.range.sha256,original.range.sha256);assert(Number.isSafeInteger(source.original.range.sourceSizeAtCapture)&&source.original.range.sourceSizeAtCapture>=source.original.range.endOffset&&source.original.range.sourceSizeAtCapture<=fs.statSync(selected.selection.rolloutRef).size);assert(source.original.range.actualReadBytes>0&&source.original.range.actualReadBytes<=8388608);assert.equal(source.original.range.maximumReadBytes,8388608);
  assert.deepEqual(original.invocation.rawPin,phase.call);assert.equal(original.invocation.turnId,phase.turnId);for(const event of original.tokenEvents)assert(Date.parse(event.timestamp)<=Date.parse(report.receivedAt));
  sourceChecks.push({endOffset:source.original.range.endOffset,contextPin:source.original.range.contextPin,invocation:{command:quote(specification.nodeExecutable)+' '+quote(selected.selection.driverRef)+' '+source.phase,workdir:root,driverRef:selected.selection.driverRef},original});
  assert.deepEqual(report.measurement,{provider:original.model.provider,model:original.model.model,inputTokens:null,outputTokens:null,totalTokens:null,cost:null,source:report.measurement.source});
  // Re-interpret the captured native responses using the same independently
  // checked real API shapes, then match them to original native request/response
  // files immediately preceding this exact authenticated report receipt.
  let consumed=0;const past=await inspectTaskAttribution({request:async(operation,input)=>{const r=source.nativeAttribution.reads[consumed++];assert(r);assert.equal(r.operation,operation);assert.deepEqual(r.input,input??{});assert.equal(r.resultDigest,valueDigest(r.result));return{result:r.result};},serviceId:run.candidate.serviceId,workspaceId:run.selection.workspaceId,projectId:run.selection.projectId,handoff});assert.equal(consumed,source.nativeAttribution.reads.length);assert.deepEqual(past,source.nativeAttribution);
  const names=fs.readdirSync(phaseRoot).filter(v=>/^\d+-native-request\.json$/.test(v)).sort((a,b)=>Number(a.split('-')[0])-Number(b.split('-')[0]));assert(names.length<=512);
  const native=[];for(const name of names){const ref=path.join(phaseRoot,name),raw=privateBytes(ref,1048576),request=JSON.parse(raw);native.push({ref,sha256:sha(raw),request,responseRef:ref.replace(/-request\.json$/,'-response.json')});}
  const matches=native.map((r,i)=>({r,i})).filter(({r})=>r.request.operation==='lifecycle.agent.report'&&r.request.input?.measurement?.source?.digest===report.measurement.source.digest);assert.equal(matches.length,1);const {r:write,i:writeIndex}=matches[0];assert.equal(write.request.projectId,run.selection.projectId);assert.deepEqual(write.request.input,{stageRequestId:plan.stageRequestId,claimDigest:claim.digest,previousReportDigest:report.previousReportDigest,state:report.state,summary:report.summary,result:report.result,measurement:report.measurement});assert.equal(native[writeIndex-1]?.request.operation,'runtime.status');
  function nativeResponse(item){const raw=privateBytes(item.responseRef,1048576),response=JSON.parse(raw);assert.equal(response.status,200);assert.equal(sha(response.rawBody),response.rawBodySha256);const body=JSON.parse(response.rawBody);assert(!body.error&&body.result!==undefined);pins.push({ref:item.ref,sha256:item.sha256},{ref:item.responseRef,sha256:sha(raw)});originalReadbacks.push({request:item.request,response});return body.result;}
  const reads=native.slice(writeIndex-1-consumed,writeIndex-1);assert.equal(reads.length,consumed);
  for(let i=0;i<reads.length;i++){const expected=source.nativeAttribution.reads[i];assert.equal(reads[i].request.operation,expected.operation);assert.equal(reads[i].request.projectId,run.selection.projectId);assert.deepEqual(reads[i].request.input,expected.input);assert.deepEqual(nativeResponse(reads[i]),expected.result);}
  const recordedReceipt=nativeResponse(write),actualReceipt=await run.read('runtime.receipt.read',{requestId:write.request.requestId});assert.deepEqual(actualReceipt,recordedReceipt);assert.equal(actualReceipt.operation,'lifecycle.agent.report');assert.equal(actualReceipt.result.reportDigest,report.digest);assert.equal(actualReceipt.requestDigest,sha(canonical({operation:write.request.operation,projectId:run.selection.projectId,input:write.request.input})));
  const indexRef=path.join(phaseRoot,'MEASUREMENT-INDEX-'+String(source.index).padStart(4,'0')+'.json'),indexBytes=privateBytes(indexRef,1048576),index=JSON.parse(indexBytes);pins.push({ref:indexRef,sha256:sha(indexBytes)});assert.equal(index.schema,'runtime-e01-measurement-index/v1');assert.equal(index.phase,source.phase);assert.equal(index.count,source.index);assert.deepEqual(index.entries,[...observations.filter(v=>v.phase===source.phase).map(v=>({index:v.index,reference:v.source.reference,digest:v.source.digest})),{index:source.index,reference:report.measurement.source.reference,digest:report.measurement.source.digest}]);
  run.artifact('measurement-original-availability.json',{reportDigest:report.digest,sourceReference:report.measurement.source,original:source,independentRawSourceRead:true,rawInstructionsOrReasoningRetained:false});
  observations.push({reportDigest:report.digest,phase:source.phase,index:source.index,source:report.measurement.source,sourceCutoff:original.range.endOffset,rawTokenEvents:original.tokenEvents.length,model:original.model.model,provider:original.model.provider,taskTokens:null,cost:null,scope:source.scope,sharedCountersPreserved:true});
 }
 const current=await inspectTaskAttribution({request:async(operation,input)=>{const r=await run.request(operation,input);assert.equal(r.status,200,'Read failure cannot manufacture empty usage');return r.body;},serviceId:run.candidate.serviceId,workspaceId:run.selection.workspaceId,projectId:run.selection.projectId,handoff});
 assert.equal(current.instancePinsDigest,initial.pinsDigest);assert.equal(current.targetVersion,handoff.preparation.target.version);
 run.artifact('measurement-original-native-readbacks.json',{originalReadbacks,currentNativeReadbacks:current.reads,taskScope:measurementTaskScope(handoff,initial),emptyQueriesAloneNotProof:true});
 for(const pin of pins)assert.equal(sha(privateBytes(pin.ref,8388608)),pin.sha256);coding.revalidate();
 // Re-read the original complete windows at exactly the already verified
 // cutoffs, including token rows outside the coding tool proof record set.
 for(const check of sourceChecks){const final=inspectHostSource(selected,check.endOffset,check.contextPin,check.invocation);for(const key of ['source','invocation','model','contexts','tokenEvents','cost','threadCountersKnown','independentTaskCountersProvided','containsReasoningOrInstructions'])assert.deepEqual(final[key],check.original[key]);assert.equal(final.range.sha256,check.original.range.sha256);assert.equal(final.range.startOffset,check.original.range.startOffset);assert.equal(final.range.endOffset,check.original.range.endOffset);}
 assert.deepEqual(await driver.original(plan.stageRequestId),before);assert.deepEqual(await run.read('lifecycle.agent.handoff.read',{stageRequestId:plan.stageRequestId}),handoffRead);assert.deepEqual(await driver.events(),eventsBefore);assert.equal((await run.read('runtime.status')).revision,statusBefore.revision);
 return{originalCase:c.caseInstanceId,originalStageRequestId:plan.stageRequestId,originalReportDigest:plan.reportDigest,targetVersion:handoff.preparation.target.version,realHostSourceBound:true,sourceReports:observations,knownThreadCountersPreserved:true,taskCountsUnattributableWithinObservedScope:true,actualCostNotProvidedInSelectedSource:true,modelKnown:true,unknownNotZero:true,hostSessionAttested:false,independentlyVerified:false,originalInstanceUnchanged:true,newRuntimeWrites:0,newStageDispatches:0,newModelCalls:0,newCiRuns:0,e01JourneyCredit:false};
}
function measurementTaskScope(handoff,instance){return{instanceId:instance.id,pinsDigest:instance.pinsDigest,targetRef:instance.pins.targetRef,targetVersion:handoff.preparation.target.version,stageRequestId:handoff.stageRequestId,sourceScope:'SHARED_HOST_SOURCE_OBSERVATION'};}

// PRIVATE PROPOSAL ONLY: parent will embed these functions in the pinned E13
// collector after scope review. No function is called by importing this file.
function lossPinned(pin){exactKeys(pin,['ref','sha256']);const raw=faultPrivate(pin.ref);assert.equal(faultSha(raw),pin.sha256);return JSON.parse(raw);}
async function lossWait(ref,end){while(Date.now()<end){if(fs.existsSync(ref))return JSON.parse(faultPrivate(ref));await faultSleep(100);}throw Error('EXACT_EXTERNAL_FAULT_EVIDENCE_UNAVAILABLE');}
function lossFixture(run,c,plan){
 exactKeys(plan,['instanceId','allowServiceRestart','faultPlan']);slug(plan.instanceId);assert.equal(plan.allowServiceRestart,true);const f=lossPinned(plan.faultPlan);
 exactKeys(f,['schema','caseInstanceId','installedRoot','serviceSelection','candidateDigest','workspaceId','projectId','instanceId','stageId','faultRoot','maxWallSeconds','source','producer']);assert.equal(f.schema,'runtime-e13-owned-inspector-fault/v1');assert.equal(f.caseInstanceId,c.caseInstanceId);assert.equal(f.installedRoot,run.selection.installedRoot);assert.equal(f.candidateDigest,run.candidateDigest);assert.equal(f.workspaceId,run.selection.workspaceId);assert.equal(f.projectId,run.selection.projectId);assert.equal(f.instanceId,plan.instanceId);assert.equal(f.maxWallSeconds,120);assert.equal(f.stageId,c.caseInstanceId.endsWith('.03')?'plan':'implementation');assert.equal(path.resolve(f.faultRoot),f.faultRoot);assert.equal(fs.realpathSync(path.dirname(f.faultRoot)),path.dirname(f.faultRoot));
 exactKeys(f.producer,['entry','helpers','protocol']);assert.equal(path.basename(f.producer.entry.ref),'inspector-fault.mjs');assert.equal(f.producer.protocol,'runtime-owned-inspector-safe-protocol/v1');assert.deepEqual(f.producer.helpers.map(p=>path.basename(p.ref)).sort(),['native-isolation.mjs','owner-readback.mjs']);for(const pin of [f.producer.entry,...f.producer.helpers]){exactKeys(pin,['ref','sha256']);assert.equal(path.dirname(pin.ref),path.dirname(f.producer.entry.ref));assert.equal(faultSha(faultPrivate(pin.ref)),pin.sha256);}
 exactKeys(f.source,['ref','sha256','boundary']);assert.equal(faultSha(fs.readFileSync(f.source.ref)),f.source.sha256);run.artifact('original-fault-selection.json',{caseInstanceId:c.caseInstanceId,fixture:f,fixturePin:plan.faultPlan,executionAuthorityFromFixture:false});return f;
}
async function lossProof(run,c,f,end){
 const restored=await lossWait(path.join(f.faultRoot,'RESTORED.json'),end);for(const key of ['caseInstanceId','candidateDigest','instanceId','stageId'])assert.equal(restored[key],f[key]);assert.equal(restored.serviceId,run.candidate.serviceId);assert.equal(restored.newOwnerWrites,0);assert.equal(restored.newProviderDispatches,0);const fault=lossPinned(restored.fault),pause=lossPinned(fault.exactPause);
 assert.equal(fault.signal,'SIGKILL');assert.equal(fault.businessRollbackClaim,false);for(const raw of [fault,pause]){assert.equal(raw.caseInstanceId,c.caseInstanceId);assert.equal(raw.serviceId,run.candidate.serviceId);assert.equal(raw.candidateDigest,run.candidateDigest);}assert.equal(fault.pid,pause.pid);assert.equal(fault.processIdentity,pause.processIdentity);assert.equal(fault.originalStageRequestId,pause.originalRequest.id);assert.deepEqual(pause.source,f.source);assert.equal(pause.workerWitness.status.observationWorker.inFlight,1);assert.equal(pause.workerWitness.status.observationWorker.automaticRedispatch,false);assert.equal(pause.workerWitness.pending.length,1);assert.equal(pause.workerWitness.pending[0].instanceId,f.instanceId);assert.equal(pause.workerWitness.pending[0].stageId,f.stageId);assert.deepEqual(pause.workerWitness.original.request,pause.originalRequest);assert.equal(pause.workerWitness.inventory.projectId,f.projectId);assert.equal(pause.workerWitness.status.revision,pause.workerWitness.inventory.revision);assert.deepEqual(pause.workerWitness.projectPages.map(p=>p.projectId),[f.projectId]);
 const actualBusy=pause.workerWitness.inventory.instances.flatMap(i=>Object.entries(i.stages).filter(([,s])=>['RUNNING','UNKNOWN'].includes(s.status)).map(([stageId,s])=>({instanceId:i.id,stageId,requestId:s.requestId})));assert.deepEqual(actualBusy,[{instanceId:f.instanceId,stageId:f.stageId,requestId:pause.originalRequest.id}]);assert(Date.parse(pause.at)>=Date.parse(pause.workerWitness.at)&&Date.parse(pause.at)-Date.parse(pause.workerWitness.at)<=10000);assert(Date.parse(fault.at)<Date.parse(pause.originalRequest.deadlineAt));
 const protocol=lossPinned(fault.protocol);assert.equal(protocol.pid,pause.pid);assert.equal(protocol.processIdentity,pause.processIdentity);assert.equal(protocol.serviceId,run.candidate.serviceId);assert.deepEqual(protocol.source,f.source);const localCalls=protocol.events.filter(e=>e.direction==='request'&&e.method==='Debugger.evaluateOnCallFrame');assert.equal(localCalls.length,1);const localReply=protocol.events.find(e=>e.direction==='response'&&e.id===localCalls[0].id);assert(localReply&&!localReply.error&&!localReply.result.exceptionDetails);assert.deepEqual(JSON.parse(localReply.result.result.value),pause.safeLocals);const pauses=protocol.events.filter(e=>e.direction==='event'&&e.method==='Debugger.paused');assert.equal(pauses.length,1);assert.equal(pauses[0].topFrame.location.lineNumber,pause.lineNumber);
 const stopped=lossPinned(restored.stop),started=lossPinned(restored.start);assert.equal(stopped.operation,'stop');assert.equal(stopped.service.running,false);assert.equal(started.operation,'start');assert.equal(started.service.running,true);assert.equal(started.service.identity.serviceId,run.candidate.serviceId);assert.equal(started.hostRegistered,false);run.artifact('original-real-fault-proof.json',{restored,fault,pause,stopped,started});return{restored,fault,pause};
}
async function lossOriginalWrite(run,operation,input,requestId,end){
 for(let attempt=0;attempt<20;attempt++){
  assert(Date.now()<end,'Original request/case deadline elapsed');const current=await run.read('runtime.status');assert(Date.now()<end);
  const value=await run.request(operation,input,{requestId,expectedRevision:current.revision});
  if(value.status===200)return value;
  assert(['REVISION_CONFLICT','EXECUTOR_BUSY'].includes(value.body.error?.code),'Only definite pre-effect native contention may be retried');
  await noReceipt(run,requestId);assert(Date.now()<end);await faultSleep(100);
 }
 throw Error('ORIGINAL_REQUEST_CONTENTION_NOT_RESOLVED');
}
async function lossReadOwners(run,f,request,label){
 const load=r=>import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist',r)).href),security=await load('server/security.js'),configApi=await load('adapters/config.js'),ownerApi=await load('adapters/published-owners.js'),base=await load('lifecycle/base.js'),control=await load('installation/service-control.js'),selected=lossPinned(f.serviceSelection);assert.deepEqual(control.inspectInstalledServiceSelection(f.installedRoot),selected);
 const stop=await control.operateInstalledService(selected,'stop');run.artifact('owner-readback-native-stop.json',stop);assert.equal(stop.service.running,false);let output={};
 try{const spec=JSON.parse(faultPrivate(path.join(f.installedRoot,'service-specification.json'))),configuration=configApi.readIntegrationConfiguration(spec.integrationsRef,run.selection.workspaceId),connection=security.readHostConnection(run.selection.connectionRef),actor=security.currentPrincipal(path.join(f.installedRoot,'data'),run.selection.workspaceId,connection.principalId);assert(actor);security.authorize(actor,run.selection.projectId,'read');
  for(const owner of ['ontology','harness']){const rows=configuration.owners.filter(r=>r.owner===owner&&r.projects.includes(f.projectId));assert.equal(rows.length,1);const {packageRoot,workspaceRoot,workspaceId,projects}=rows[0],adapter=await ownerApi.openPublishedOwner({owner,packageRoot,workspaceRoot,workspaceId,projects});try{const scope={visibility:'private',projectId:f.projectId},before=await adapter.read(actor,f.projectId,{operation:'workspace.inspect',scope,input:{}}),nativeRequest={operation:'native.receipt.inspect',scope,input:{requestId:'plan-native-'+base.valueDigest({requestId:request.id,projectId:f.projectId,owner}).slice(7,55)}},receipt=await adapter.read(actor,f.projectId,nativeRequest),after=await adapter.read(actor,f.projectId,{operation:'workspace.inspect',scope,input:{}});assert.deepEqual(after,before);output[owner]={identity:adapter.capabilities(),request:nativeRequest,receipt,workspace:before};run.artifact('owner-original-readback.json',{label,owner,...output[owner]});}finally{adapter.close();}}
 }finally{const start=await control.operateInstalledService(selected,'start');run.artifact('owner-readback-native-start.json',start);assert.equal(start.service.running,true);assert.equal(start.service.identity.serviceId,run.candidate.serviceId);}
 return output;
}
async function originalOwnerLoss(run,driver,c,plan){
 const f=lossFixture(run,c,plan),before=await driver.instance(plan.instanceId),saved=before.instance;assert.equal(saved.stages.scope.status,'PASSED');assert.equal(saved.stages.plan.status,'PENDING');assert.equal(saved.stages.plan.attempts,0);assert.equal(saved.stages.plan.requestId,null);assert(Object.entries(saved.stages).filter(([id])=>id!=='scope').every(([,s])=>s.status==='PENDING'));const scope=await run.read('lifecycle.scope.evidence.read',{stageRequestId:saved.stages.scope.requestId}),baseline=await driver.events(),view=await run.read('lifecycle.definition.inspect');
 const end=Math.min(Date.now()+180000,Math.min(Date.parse(saved.createdAt)+saved.pins.budget.timeoutSeconds*1000,Date.parse(saved.pins.authorityExpiresAt)));assert(end-Date.now()>60000);await lossWait(path.join(f.faultRoot,'ARMED.json'),end);const admission=await run.read('lifecycle.stage.admission',{instanceId:saved.id,stageId:'plan'});assert.equal(admission.allowed,true);const status=await run.read('runtime.status'),requestId=run.requestId(c.caseInstanceId,'original-plan'),input={instanceId:saved.id,stageId:'plan'};assert(Date.now()<end);await noReceipt(run,requestId);
 try{const submitted=await lossOriginalWrite(run,'lifecycle.stage.request',input,requestId,end);assert.equal(submitted.status,200);}catch(error){run.artifact('original-plan-transport.json',{requestId,code:typeof error.code==='string'?error.code:'TRANSPORT_OR_RESPONSE_UNAVAILABLE',retry:false,requiresOriginalReceipt:true});}
 const proof=await lossProof(run,c,f,end),receipt=await run.read('runtime.receipt.read',{requestId});assert.equal(receipt.operation,'lifecycle.stage.request');assert.equal(receipt.result.stageRequestId,proof.pause.originalRequest.id);const id=receipt.result.stageRequestId,original=await driver.original(id);assert.deepEqual(original.request,proof.pause.originalRequest);assert.equal(original.instance.stages.plan.attempts,1);assert(['RUNNING','UNKNOWN'].includes(original.progress.phase));assert.equal(original.progress.terminal,false);assert.equal(original.instance.stages.implementation.status,'PENDING');
 const owned=lossPinned(proof.restored.owners);assert.equal(owned.readOnly,true);assert.equal(owned.newOwnerMutations,0);assert.equal(owned.originalRequestId,id);assert.deepEqual(owned.owners.harness.receipt,proof.pause.safeLocals.claim);const evidence=await run.read('lifecycle.plan.evidence.read',{stageRequestId:id});assert.equal(evidence.authorityGranted,false);assert.deepEqual(evidence.owners.ontology.receipt,owned.owners.ontology.receipt);assert.equal(evidence.owners.harness.receipt,null);
 const installed=await import(pathToFileURL(path.join(f.installedRoot,'package/dist/adapters/stages.js')).href),p=original.request.plan.parameters,results={};for(const owner of ['ontology','harness']){const action=evidence.owners[owner].action;assert(action);assert.equal(action.request.requestId,owned.owners[owner].receipt.requestId);results[owner]=installed.verifyNativeStageResult(owned.owners[owner].receipt,owner,p.owners[owner],action,p.toolchainLockDigest,p.effectiveConfigDigest);}assert.equal(results.ontology.status,'PASS');assert.equal(results.harness.status,'UNKNOWN');assert.equal(results.harness.receiptDigest,null);
 // Explicit reconcile is inspect-only. It retains the same immutable action
 // and cannot resume or replay the interrupted native Harness validation.
 assert(Date.now()<end);const current=await run.read('runtime.status');assert(Date.now()<end);const reconciled=await lossOriginalWrite(run,'lifecycle.stage.reconcile',{stageRequestId:id},run.requestId(c.caseInstanceId,'inspect-original'),end);assert.equal(reconciled.status,200);const after=await driver.until(id,v=>['RUNNING','UNKNOWN'].includes(v.progress.phase),'original uncertain owner readback',15000);assert(Date.now()<end);assert.deepEqual(after.request,original.request);assert.equal(after.instance.stages.plan.attempts,1);assert.equal(after.instance.stages.implementation.status,'PENDING');assert.deepEqual(await run.read('lifecycle.plan.evidence.read',{stageRequestId:id}),evidence);
 const afterOwners=await lossReadOwners(run,f,original.request,'after-reconcile');assert.deepEqual(afterOwners,owned.owners,'Native receipt and owner revision must be byte-equivalent after recovery');assert.deepEqual(await run.read('runtime.receipt.read',{requestId}),receipt);assert.deepEqual(await run.read('lifecycle.scope.evidence.read',{stageRequestId:saved.stages.scope.requestId}),scope);assert.deepEqual((await run.read('lifecycle.definition.inspect')).active,view.active);const events=await driver.events();assert.deepEqual(events.slice(0,baseline.length),baseline);const added=events.slice(baseline.length);assert.equal(added.filter(e=>e.type==='stage-requested').length,1);assert.equal(added.filter(e=>e.type==='stage-requested')[0].data.stageRequestId,id);assert(!added.some(e=>['stage-advance-requested','lifecycle-instance-created','agent-claimed','agent-reported'].includes(e.type)));
 run.artifact('one-sided-owner-recovery.json',{originalRequest:original.request,originalReceipt:receipt,scopeEvidence:scope,planEvidence:evidence,ownerResults:results,ownersBefore:owned.owners,ownersAfter:afterOwners,addedEvents:added,finalOriginalPhase:after.progress.phase,validationCompleted:false,unknownClaimResumed:false,redispatches:0,formalCaseCredit:0});assert.deepEqual(lossPinned(plan.faultPlan),f);for(const pin of [f.producer.entry,...f.producer.helpers])assert.equal(faultSha(faultPrivate(pin.ref)),pin.sha256);return{oneBusinessInstance:saved.id,scopePreserved:true,samePlanOntology:'PASS',samePlanHarness:'UNKNOWN',originalClaimRetained:true,nativeServiceRecovery:true,reconcileInspectsOriginalOnly:true,ownerValidationComplete:false,newProviderRuns:0,newHostRuns:0};
}
async function originalProviderLoss(run,driver,c,plan){
 const f=lossFixture(run,c,plan),before=await driver.instance(plan.instanceId),instance=before.instance;assert.equal(instance.stages.scope.status,'PASSED');assert.equal(instance.stages.plan.status,'PASSED');assert.equal(instance.stages.implementation.attempts,1);assert.equal(instance.stages.implementation.status,'RUNNING');const id=instance.stages.implementation.requestId,original=await driver.original(id),handoff=await run.read('lifecycle.agent.handoff.read',{stageRequestId:id});assert.equal(handoff.latestReport.state,'SUBMITTED');assert(handoff.claim);assert.equal(handoff.handoff.runtimeStartsAgent,false);const initial=await run.read('lifecycle.implementation.evidence.read',{stageRequestId:id});assert.equal(initial.derivation,null,'Fault must cover the first true provider dispatch, not a later read');assert.equal(initial.ci,null);const baseline=await driver.events(),end=Math.min(Date.now()+180000,Date.parse(original.request.deadlineAt));assert(end-Date.now()>60000);
 await lossWait(path.join(f.faultRoot,'ARMED.json'),end);const status=await run.read('runtime.status');assert.equal(status.observationWorker.inFlight,0);assert(Date.now()<end);const requestId=run.requestId(c.caseInstanceId,'original-ci-advance');try{const reply=await lossOriginalWrite(run,'lifecycle.stage.advance',{stageRequestId:id},requestId,end);assert.equal(reply.status,200);}catch(error){run.artifact('original-provider-transport.json',{requestId,code:typeof error.code==='string'?error.code:'TRANSPORT_OR_RESPONSE_UNAVAILABLE',retry:false,requiresOriginalReceipt:true});}
 const proof=await lossProof(run,c,f,end);assert.deepEqual(proof.pause.originalRequest,original.request);const received=proof.pause.safeLocals;assert.equal(received.response.bodyUsed,false);assert.equal(received.response.ok,true);assert([200,201,202].includes(received.response.status));assert.equal(received.response.hasBody,true);const advance=await run.read('runtime.receipt.read',{requestId});assert.equal(advance.operation,'lifecycle.stage.advance');assert.equal(advance.result.stageRequestId,id);assert.equal(advance.result.newAttempt,false);const retained=await run.read('lifecycle.implementation.evidence.read',{stageRequestId:id});assert(retained.derivation);driver.intact(retained.derivation);driver.intact(retained.derivation.request);assert.equal(retained.derivation.parentRequestId,id);assert.equal(retained.derivation.parentRequestDigest,original.request.digest);assert.equal(retained.derivation.agentReportDigest,handoff.latestReport.digest);assert.equal(retained.derivation.request.deadlineAt,original.request.deadlineAt);
 const load=r=>import(pathToFileURL(path.join(f.installedRoot,'package/dist',r)).href),platforms=await load('adapters/platforms.js'),base=await load('lifecycle/base.js'),configApi=await load('adapters/config.js'),security=await load('server/security.js'),child=retained.derivation.request,p=child.plan.parameters,binding=p.binding;
 const ci={schema:'runtime-ci-request/v1',requestId:'stage-'+base.valueDigest({workspaceId:child.workspaceId,projectId:child.projectId,requestId:child.id}).slice(7,55),projectId:child.projectId,bindingDigest:base.valueDigest(binding),commit:p.commit,workflowDigest:p.workflowDigest,inputDigest:child.inputDigest,stageId:child.stageId,candidateDigest:p.candidateDigest,requestedAt:child.requestedAt,deadlineAt:child.deadlineAt};assert.equal(binding.provider,'github');assert.equal(received.repositoryId,binding.repositoryId);assert.equal(received.repository,binding.repository);assert.equal(received.workflowPath,binding.workflowPath);assert.deepEqual(received.payload,{ref:platforms.ciSourceRef(ci),inputs:platforms.ciInputs(ci),return_run_details:true});assert.equal(received.response.url,'https://api.github.com/repos/'+binding.repository+received.suffix);
 const spec=JSON.parse(faultPrivate(path.join(f.installedRoot,'service-specification.json'))),connection=security.readHostConnection(run.selection.connectionRef);const actor=()=>{const value=security.currentPrincipal(path.join(f.installedRoot,'data'),run.selection.workspaceId,connection.principalId);assert(value);security.authorize(value,run.selection.projectId,'read');return value;};
 async function get(suffix,label){
  assert(['before-native-reconcile','after-native-reconcile'].includes(label));assert(Date.now()<end,'Original request/case deadline elapsed before independent provider read');
  const token=configApi.readPlatformToken(spec.integrationsRef,binding,actor());assert(Date.now()<end);
  const response=await fetch('https://api.github.com/repos/'+binding.repository+suffix,{method:'GET',headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'},redirect:'error',signal:AbortSignal.timeout(Math.min(10000,end-Date.now()))}),raw=await response.text();
  assert(Buffer.byteLength(raw)<=2097152);run.artifact('independent-original-github-read.json',{label,method:'GET',provider:'github',repositoryId:binding.repositoryId,requestId:ci.requestId,commit:ci.commit,sourceRef:platforms.ciSourceRef(ci),runTitle:platforms.ciRunTitle(ci),path:suffix,status:response.status,rawBody:raw});
  assert(Date.now()<end,'Original request/case deadline elapsed during independent provider read');assert.equal(response.status,200);return JSON.parse(raw);
 }
 async function inventory(label){
  const matches=[],pages=[];let complete=false;
  for(let page=1;page<=10;page++){
   assert(Date.now()<end,'Original request/case deadline elapsed during provider inventory');
   const suffix='/actions/workflows/'+encodeURIComponent(binding.workflowPath.split('/').at(-1))+'/runs?event=workflow_dispatch&head_sha='+ci.commit+'&per_page=100&page='+page,value=await get(suffix,label);assert(Date.now()<end);
   assert(Array.isArray(value.workflow_runs)&&value.workflow_runs.length<=100);
   const selected=value.workflow_runs.filter(r=>r.head_branch===platforms.ciSourceRef(ci)&&r.display_title===platforms.ciRunTitle(ci));
   for(const found of selected){assert.equal(String(found.repository.id),binding.repositoryId);assert.equal(found.head_sha,ci.commit);assert.equal(found.path,binding.workflowPath);assert.equal(found.event,'workflow_dispatch');assert.equal(found.run_attempt,1);}
   matches.push(...selected);pages.push({page,path:suffix,returned:value.workflow_runs.length,matchingRunIds:selected.map(r=>r.id)});
   if(value.workflow_runs.length<100){complete=true;break;}
  }
  const evidence={label,repositoryId:binding.repositoryId,workflowPath:binding.workflowPath,requestId:ci.requestId,commit:ci.commit,sourceRef:platforms.ciSourceRef(ci),runTitle:platforms.ciRunTitle(ci),pages,complete,matchingRuns:matches};run.artifact('independent-original-github-inventory.json',evidence);
  assert(Date.now()<end);assert(complete,'Original provider inventory must finish within the fixed ten-page bound');assert.equal(matches.length,1,'Exactly one real original run before and after recovery; absence or duplicates cannot pass');return evidence;
 }
 function exactRemote(remote,runId){assert.equal(remote.id,runId);assert.equal(String(remote.repository.id),binding.repositoryId);assert.equal(remote.head_sha,ci.commit);assert.equal(remote.head_branch,platforms.ciSourceRef(ci));assert.equal(remote.display_title,platforms.ciRunTitle(ci));assert.equal(remote.path,binding.workflowPath);assert.equal(remote.event,'workflow_dispatch');assert.equal(remote.run_attempt,1);assert.equal(remote.html_url,binding.host+'/'+binding.repository+'/actions/runs/'+remote.id);}
 const beforeInventory=await inventory('before-native-reconcile'),remote=await get('/actions/runs/'+beforeInventory.matchingRuns[0].id,'before-native-reconcile');exactRemote(remote,beforeInventory.matchingRuns[0].id);
 assert(Date.now()<end);const current=await run.read('runtime.status');assert(Date.now()<end);const inspect=await lossOriginalWrite(run,'lifecycle.stage.reconcile',{stageRequestId:id},run.requestId(c.caseInstanceId,'inspect-original-run'),end);assert.equal(inspect.status,200);let observed;while(Date.now()<end){observed=await run.read('lifecycle.implementation.evidence.read',{stageRequestId:id});assert.deepEqual(observed.derivation,retained.derivation);if(observed.ci?.run?.runId){assert.equal(String(observed.ci.run.runId),String(remote.id));assert.equal(observed.ci.run.requestId,ci.requestId);break;}await faultSleep(250);}assert(Date.now()<end);assert(observed.ci.run);assert.equal(observed.ci.observation.runId,String(remote.id));assert.equal(observed.ci.observation.requestId,ci.requestId);assert.equal(observed.ci.observation.commit,ci.commit);assert.equal(observed.ci.observation.inputDigest,ci.inputDigest);
 assert.deepEqual((await driver.original(id)).request,original.request);assert.deepEqual(await run.read('lifecycle.agent.handoff.read',{stageRequestId:id}),handoff);assert.deepEqual(await run.read('runtime.receipt.read',{requestId}),advance);assert.equal((await driver.instance(instance.id)).instance.stages.implementation.attempts,1);const events=await driver.events();assert.deepEqual(events.slice(0,baseline.length),baseline);const added=events.slice(baseline.length);assert.equal(added.filter(e=>e.type==='stage-advance-requested').length,1);assert.equal(added.filter(e=>e.type==='stage-advance-requested')[0].data.stageRequestId,id);assert(!added.some(e=>['stage-requested','lifecycle-instance-created','agent-claimed','agent-reported'].includes(e.type)));const afterInventory=await inventory('after-native-reconcile');assert.equal(afterInventory.matchingRuns[0].id,remote.id,'Recovery must preserve the single original provider run; a replacement or second run is forbidden');const finalRemote=await get('/actions/runs/'+remote.id,'after-native-reconcile');exactRemote(finalRemote,remote.id);assert(Date.now()<end);
 run.artifact('real-provider-loss-recovery.json',{parentRequest:original.request,derivation:retained.derivation,ci,advance,actualPause:received,remote,finalRemote,beforeInventory,afterInventory,nativeReadback:observed,addedEvents:added,providerRedispatches:0,remoteRunCount:afterInventory.matchingRuns.length,transportCancellationImpliesRollback:false,formalCaseCredit:0});assert.deepEqual(lossPinned(plan.faultPlan),f);for(const pin of [f.producer.entry,...f.producer.helpers])assert.equal(faultSha(faultPrivate(pin.ref)),pin.sha256);return{sameBusinessInstance:instance.id,originalCodingClaimPreserved:true,actualGitHubResponseBodyLost:true,independentOriginalRunId:String(remote.id),runAttempt:1,oneOriginalProviderRun:true,nativeOriginalReadbackRecovered:true,newProviderDispatchAfterFault:false,newHostTurn:false,fullJourneyNotCredited:true};
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
   if(c.caseInstanceId==='E13.variant.03')return originalOwnerLoss(run,driver,c,plan);
   if(c.caseInstanceId==='E13.variant.04')return originalProviderLoss(run,driver,c,plan);
   if(c.caseInstanceId==='E13.variant.05')return unavailableTaskMeasurement(run,driver,c,plan);
   if(c.caseInstanceId==='E13.variant.06')return unsupportedLimit(run,driver,c,plan);
   throw Error('UNIMPLEMENTED_ORIGINAL_CASE: '+c.caseInstanceId);
  });
 }finally{run.finish();}
});
