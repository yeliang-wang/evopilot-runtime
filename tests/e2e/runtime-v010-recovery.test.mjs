import assert from 'node:assert/strict';
import {createHmac,randomBytes} from 'node:crypto';
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  createReferenceDeliveryAdapter, startReferenceChannel, startReferenceDeliveryInbox,
} from '../../dist/feedback-loop/callback-channel.js';
import {createCursorAgentAdapter} from '../../dist/feedback-loop/cursor.js';
import {createFeedbackGitHubAdapter} from '../../dist/feedback-loop/github.js';
import {retainFeedbackChannelEvent} from '../../dist/feedback-loop/ingress.js';
import {createLinearIssueAdapter} from '../../dist/feedback-loop/linear.js';
import {
  reserveFeedbackReviewNotification, retainFeedbackProgress, retainFeedbackReview, retainFeedbackVeto,
} from '../../dist/feedback-loop/service.js';
import {normalizeSlackSocketModeEvent} from '../../dist/feedback-loop/slack.js';
import {
  createFeedbackVerification, feedbackVerificationExecutionId, prepareFeedbackVerificationEvaluation,
} from '../../dist/feedback-loop/verification.js';
import {createFeedbackWorkflowWorker} from '../../dist/feedback-loop/worker.js';
import {digest} from '../../dist/server/errors.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {NATIVE_CONTRACT_DIGEST, nativeSha256} from '../../vendor/compatibility/v1/native.mjs';

test('the feedback worker recovers the retained Linear issue after SQLite restart without redispatch', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-v010-workflow-recovery-'));
  const workspaceId = 'demo', projectId = 'tasks';
  const scope = {provider:'slack',installationId:'A00',tenantId:'T00',channelId:'C00'};
  const route = {workspaceId,projectId,scope};
  const actor = {
    id:'feedback-worker',projects:[projectId],permissions:['read','execution.request'],
    revision:1,expiresAt:'2099-01-01T00:00:00Z',
  };
  const linearScope = {
    teamId:'42bdea2e-2fad-4a86-969a-9e9b9d12f1d0',
    projectId:'3ab1f6ae-79fd-4d7b-963e-2d213830b709',
    openStateId:'6cb465d2-9cc5-4993-8b6c-c85a6f7aea9f',
    needsInfoStateId:'694f0b0d-3f00-4498-a37c-bda169ba873b',
    closedStateId:'b06a9637-950c-4152-9d11-9f086e8eaa0b',
  };
  const expiresAt = Date.now()+60_000;
  const unexpected = () => assert.fail('The issue recovery fixture reached an unrelated adapter');
  const {installationId,tenantId,channelId} = scope;
  let store;
  try {
    const reopen = () => {
      store?.close();
      store = new RuntimeStore(root,workspaceId);
    };
    reopen();
    const read = (kind,id) => store.object(projectId,kind,id);
    const retain = (eventId,messageId,text) => {
      const {eventKey,payloadDigest,...envelope} = normalizeSlackSocketModeEvent({
        type:'events_api',envelope_id:eventId,payload:{
          type:'event_callback',api_app_id:installationId,team_id:tenantId,event_id:eventId,
          event:{type:'message',channel:channelId,user:'U00',ts:messageId,text},
        },
      },scope);
      const retained = retainFeedbackChannelEvent(store,route,actor,envelope);
      assert.equal(retained.status,'RETAINED');
      assert.equal(retained.eventKey,eventKey);
      return {...retained,payloadDigest};
    };
    const originalText = 'Export omits the label.\nOpen the saved report to reproduce.';
    const original = retain('Ev001','1732471200.001000',originalText);
    const {caseId} = original;
    const originalCase = read('feedback-case',caseId);
    const feedbackBindingStamp = digest('local fixture feedback binding');
    const activation = {
      workspaceId,projectId,serviceId:store.serviceId,feedbackBindingStamp,
      definitionPointer:digest(read('definition-pointer','active')),
    };
    const activationId = 'sha256:'+digest(activation);
    // Seed a local owner activation so the test isolates worker recovery from activation review.
    store.mutate(actor,{
      projectId,operation:'fixture.feedback.activation',requestId:'fixture-activation',
      expectedRevision:store.revision(projectId),permission:'execution.request',input:{},
    },() => ({
      value:{},event:{type:'fixture-feedback-activation',data:{}},objects:[
        {kind:'feedback-activation',id:activationId,value:{subject:activation,candidateDigest:activationId,validUntil:expiresAt}},
        {kind:'feedback-activation-pointer',id:'current',value:activationId},
      ],
    }));

    const issues = new Map(), requests = [], reservations = [];
    let readbackAvailable = false, revokeOnReadback = false;
    const linearTransport = {async request(query,variables) {
      if (query.includes('mutation RuntimeLinearCreate')) {
        const {id,title,description,projectId:linearProject,teamId,stateId} = variables.input;
        requests.push({operation:'create',id});
        reservations.push(store.objectsPage(projectId,'feedback-case-issue-intent').find(row => row.value.issueId === id));
        issues.set(id,{id,title,description,archivedAt:null,team:{id:teamId},project:{id:linearProject},
          state:{id:stateId,type:'unstarted'}});
        throw Error('Fixture lost the create response after applying the effect');
      }
      const {id} = variables;
      requests.push({operation:query.includes('query RuntimeLinearRead') ? 'read' : query,id});
      if (!readbackAvailable) throw Error('Fixture readback temporarily unavailable');
      if (revokeOnReadback) admitted = false;
      return {data:{issue:issues.get(id) ?? null}};
    }};
    const cursorScope = {repository:'https://github.com/example/feedback-lab',branch:'main'};
    const github = createFeedbackGitHubAdapter({
      repository:'example/feedback-lab',repositoryId:'99',baseBranch:'main',installationId:'42',
      installationCredentialRef:'credential:fixture/github',actorId:'73',actorLogin:'fixture[bot]',allowedPaths:['docs/export.md'],
    },unexpected,unexpected);
    let admitted = false, admissionSubject;
    const worker = () => createFeedbackWorkflowWorker(store,{
      workspaceId,projectId,activationId,feedbackBindingStamp,principalId:actor.id,principal:() => actor,maxRepairs:0,
      admit: subject => {
        admissionSubject = subject;
        return admitted ? {subjectDigest:digest(subject),expiresAt} : null;
      },
      triage: async subject => {
        const retainedCase = read('feedback-case',subject.caseId);
        const retainedEvent = read('feedback-channel-event',retainedCase.originalEventKey);
        assert.deepEqual(subject.originalEvent,retainedEvent.event);
        assert.equal(subject.issueReceiptDigest,digest(read('feedback-case-issue',subject.caseId)));
        return {status:'REJECTED',subjectDigest:digest(subject),expiresAt,evidenceRef:'fixture:triage/rejected'};
      },
      linear:{scope:linearScope,adapter:createLinearIssueAdapter(linearScope,linearTransport)},
      channel:{scope,adapter:{source:'SLACK_PROVIDER',dispatch:unexpected,reconcile:unexpected}},
      cursor:{scope:cursorScope,adapter:createCursorAgentAdapter(cursorScope,{request:unexpected}),permits:unexpected},
      verification:{rule:{},verifier:{inspect:unexpected},readCandidate:unexpected},
      review:{scope:{workspaceId,projectId,channel:scope,allowedActorIds:['U01']},adapter:github,currentPolicy:unexpected},
    });
    let current = worker();
    const beforeAdmission = store.revision(projectId);
    assert.equal(await current.runOnce(),null);
    assert.equal(admissionSubject.caseId,caseId);
    assert.equal(admissionSubject.originalEventDigest,original.payloadDigest);
    assert.equal(read('feedback-workflow',activationId),null);
    assert.equal(store.revision(projectId),beforeAdmission);
    assert.deepEqual(requests,[]);

    admitted = true;
    const selected = await current.runOnce();
    assert.equal(selected.caseId,caseId);
    assert.equal(selected.phase,'issue');
    assert.deepEqual(read('feedback-workflow-assignment',caseId),{activationId,bindingDigest:selected.bindingDigest});
    admitted = false;
    const beforeClaim = store.revision(projectId);
    await assert.rejects(current.runOnce(),{code:'FEEDBACK_WORKER_ADMISSION'});
    assert.equal(store.revision(projectId),beforeClaim);
    assert.equal(read('feedback-case-issue-intent',caseId),null);
    assert.deepEqual(requests,[]);

    admitted = true;
    assert.deepEqual(await current.runOnce(),selected);
    const intent = read('feedback-case-issue-intent',caseId);
    assert.deepEqual(reservations,[{id:caseId,value:intent}]);
    assert.equal(intent.kind,'create');
    assert.equal(intent.body,originalText);
    const {issueId,intentId} = intent;
    const issueRequests = [{operation:'create',id:issueId},{operation:'read',id:issueId}];
    assert.deepEqual(requests,issueRequests);
    assert.equal(issues.size,1);
    assert.equal(read('feedback-case-issue',caseId),null);
    const pending = read('feedback-case-progress',caseId);
    assert.equal(pending.stage,'issue');
    assert.equal(pending.status,'UNKNOWN');
    assert.equal(pending.timeline.at(-1).reason,'LINEAR_READBACK_PENDING');
    assert.equal(pending.timeline.at(-1).ref,intentId);

    reopen();
    current = worker();
    assert.deepEqual(read('feedback-case',caseId),originalCase);
    assert.deepEqual(read('feedback-workflow',activationId),selected);
    assert.deepEqual(read('feedback-case-issue-intent',caseId),intent);
    assert.deepEqual(read('feedback-case-progress',caseId),pending);
    readbackAvailable = true;
    revokeOnReadback = true;
    const beforeReadback = store.revision(projectId);
    await assert.rejects(current.runOnce(),{code:'FEEDBACK_WORKER_ADMISSION'});
    assert.equal(store.revision(projectId),beforeReadback);
    assert.equal(read('feedback-case-issue',caseId),null);
    assert.deepEqual(read('feedback-workflow',activationId),selected);
    revokeOnReadback = false;
    admitted = true;
    const recovered = await current.runOnce();
    assert.equal(recovered.phase,'triage');
    assert.equal(recovered.sequence,selected.sequence+1);
    assert.equal(recovered.caseId,caseId);
    assert.deepEqual(read('feedback-workflow',activationId),recovered);
    assert.deepEqual(requests,[...issueRequests,{operation:'read',id:issueId},{operation:'read',id:issueId}]);
    assert.equal(issues.size,1);
    assert.deepEqual(read('feedback-case-issue',caseId),{
      source:'FIXTURE',scopeDigest:digest(linearScope),issueId,intentId,originalIntentId:intentId,
      stateId:linearScope.openStateId,descriptionDigest:digest(issues.get(issueId).description),
    });
    const confirmed = read('feedback-case-progress',caseId);
    assert.equal(confirmed.stage,'issue');
    assert.equal(confirmed.status,'COMPLETE');
    assert.equal(confirmed.timeline.at(-1).reason,'LINEAR_ISSUE_CONFIRMED');

    const failed = await current.runOnce();
    assert.equal(failed.phase,'failed');
    assert.equal(failed.reason,'TRIAGE_REJECTED');
    assert.deepEqual(read('feedback-workflow-terminal',caseId),{activationId,phase:'failed',stateDigest:digest(failed)});
    reopen();
    current = worker();
    assert.equal(await current.runOnce(),null);
    const nextCase = retain('Ev002','1732471201.002000','The export contains duplicate rows.');
    const next = await current.runOnce();
    assert.equal(next.phase,'issue');
    assert.equal(next.caseId,nextCase.caseId);
    assert.equal((await current.runOnce()).phase,'triage');
    const nextIssue = read('feedback-case-issue',nextCase.caseId);
    assert.notEqual(nextIssue.issueId,issueId);
    assert.equal((await current.runOnce()).phase,'failed');
    reopen();
    assert.equal(await worker().runOnce(),null);
    assert.deepEqual(requests.filter(({operation}) => operation === 'create'),[
      {operation:'create',id:issueId},{operation:'create',id:nextIssue.issueId},
    ]);
  } finally {
    store?.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('authenticated feedback monitor reads persisted visited and return paths, real review time and veto evidence', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-v010-feedback-monitor-'));
  const token = randomBytes(32).toString('hex');
  const actor = {
    id:'monitor-fixture',projects:['tasks','other'],permissions:['read','execution.request'],
    revision:1,expiresAt:'2099-01-01T00:00:00Z',
  };
  const workspaceId = 'demo', projectId = 'tasks';
  const scope = {provider:'callback',installationId:'adapter',tenantId:'team',channelId:'channel'};
  const route = {workspaceId,projectId,scope};
  const caseEnvelope = {
    schema:'runtime-feedback-channel-event/v1',scope,eventId:'message-event',messageId:'feedback-message',
    actorId:'reporter',action:{kind:'feedback',text:'Do not expose the private report in the dashboard.'},
  };
  const reviewScope = {workspaceId,projectId,channel:{...scope,channelId:'review-channel'},allowedActorIds:['reviewer']};
  const candidate = {
    workspaceId,projectId,repositoryId:'99',pullRequestId:'17',head:'a'.repeat(40),base:'b'.repeat(40),
    evidenceDigest:'c'.repeat(64),policyDigest:'d'.repeat(64),
  };
  let store, server;
  try {
    initializeCredentials(root,workspaceId,[{...actor,tokenDigest:tokenDigest(token)}]);
    store = new RuntimeStore(root,workspaceId);
    const {caseId} = retainFeedbackChannelEvent(store,route,actor,caseEnvelope);
    const advance = (stage,status,reason,ref,reviewId) => retainFeedbackProgress(
      store,actor,projectId,caseId,{stage,status,reason,ref,...(reviewId ? {reviewId} : {})},
    );
    assert.throws(() => advance('verify','RUNNING','VERIFICATION_STARTED','fixture:verifier'), {code:'FEEDBACK_PROGRESS_INVALID'});
    advance('issue','COMPLETE','ISSUE_LINKED','fixture:issue');
    advance('reproduce','RUNNING','CURSOR_STARTED','fixture:cursor');
    advance('repair','COMPLETE','PR_UPDATED','fixture:pr');
    advance('verify','FAILED','VERIFICATION_FAILED','fixture:failed-check');
    const returned = advance('repair','RUNNING','VERIFICATION_FAILED','fixture:failed-check');
    const afterProgress = store.revision(projectId);
    assert.equal(returned.timeline.at(-1).returnFrom,'verify');
    advance('repair','RUNNING','VERIFICATION_FAILED','fixture:failed-check');
    assert.equal(store.revision(projectId),afterProgress);
    advance('verify','COMPLETE','VERIFICATION_PASSED','fixture:passing-check');
    const notice = reserveFeedbackReviewNotification(store,actor,reviewScope,candidate).intent;
    const review = retainFeedbackReview(store,actor,reviewScope,candidate,notice.intentRef,'review-notice',Date.now());
    advance('review','WAITING','REVIEW_OPENED','fixture:review',review.id);
    const revision = store.revision(projectId);
    store.close();
    store = null;
    server = await startRuntimeServer({stateRoot:root,workspaceId});
    const post = (path,input,headers) => fetch(server.url+path,{
      method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(input),
    });
    const connect = async project => {
      const issued = await post('/api/v1/dashboard-code',{projectId:project},{authorization:'Bearer '+token});
      assert.equal(issued.status,200);
      const connected = await post('/api/v1/dashboard/session',{code:(await issued.json()).result.code},{origin:server.url});
      assert.equal(connected.status,200);
      return connected.headers.get('set-cookie').split(';')[0];
    };
    const path = '/api/v1/dashboard/feedback-monitor';
    const get = (route,cookie) => fetch(server.url+route,{headers:cookie ? {cookie} : {}});
    const cookie = await connect(projectId);
    assert.equal((await get(path)).status,401);
    assert.equal((await (await get('/api/v1/dashboard/monitor',cookie)).json()).result.feedbackMonitor,true);
    const before = await get(path,cookie);
    assert.equal(before.status,200);
    const value = (await before.json()).result;
    assert.equal(value.readOnly,true);
    assert.equal(value.revision,revision);
    assert.equal(value.projectId,projectId);
    assert.deepEqual(value.cases[0].visited,['receive','issue','reproduce','repair','verify','review']);
    assert.equal(value.cases[0].timeline.find(event => event.returnFrom === 'verify').stage,'repair');
    assert.deepEqual(value.cases[0].review,{
      deadline:review.openedAt+3_600_000,state:'OPEN',head:candidate.head,pullRequestId:'17',
    });
    assert(!JSON.stringify(value).includes(caseEnvelope.action.text));
    assert.equal((await get(path+'?after='+encodeURIComponent(caseId),cookie)).status,400);
    const stale = await get(path+'?after='+encodeURIComponent(caseId)+'&revision='+(revision-1),cookie);
    assert.equal((await stale.json()).error.code,'MONITOR_REVISION_CHANGED');
    const other = await connect('other');
    assert.deepEqual((await (await get(path,other)).json()).result.cases,[]);
    assert.equal((await (await get('/api/v1/dashboard/monitor',other)).json()).result.feedbackMonitor,undefined);
    await server.close();
    server = null;
    store = new RuntimeStore(root,workspaceId);
    retainFeedbackVeto(store,actor,reviewScope,{
      ...caseEnvelope,scope:reviewScope.channel,eventId:'veto-event',messageId:'review-notice',
      actorId:'reviewer',action:{kind:'veto',reviewId:review.id},
    },() => review.openedAt+10);
    store.close();
    store = null;
    server = await startRuntimeServer({stateRoot:root,workspaceId});
    const current = (await (await get(path,await connect(projectId))).json()).result;
    assert.equal(current.cases[0].review.state,'VETOED');
    assert.equal(current.revision,revision+1);
  } finally {
    await server?.close();
    store?.close();
    rmSync(root,{recursive:true,force:true});
  }
});


const workspaceId = 'demo', projectId = 'tasks';
const scope = {provider:'callback',installationId:'fixture-app',tenantId:'team',channelId:'feedback'};
const route = {workspaceId,projectId,scope};
const reviewScope = {workspaceId,projectId,channel:scope,allowedActorIds:['reviewer']};
const repository = 'preview/demo-feedback';
const cursorScope = {repository:'https://github.com/'+repository,branch:'main'};
const base = 'b'.repeat(40), initialHead = 'a'.repeat(40), repairedHead = 'c'.repeat(40);
const landedSha = 'd'.repeat(40), tree = 'e'.repeat(40);
const pr = {url:cursorScope.repository+'/pull/5',number:5,branch:'fix/feedback'};
const operationId = '630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42';
const linearScope = {
  teamId:'42bdea2e-2fad-4a86-969a-9e9b9d12f1d0',
  projectId:'3ab1f6ae-79fd-4d7b-963e-2d213830b709',
  openStateId:'6cb465d2-9cc5-4993-8b6c-c85a6f7aea9f',
  needsInfoStateId:'694f0b0d-3f00-4498-a37c-bda169ba873b',
  closedStateId:'b06a9637-950c-4152-9d11-9f086e8eaa0b',
};

function linearFixture() {
  let issue;
  const writes = [];
  const adapter = createLinearIssueAdapter(linearScope,{async request(query,vars) {
    if (query.includes('query RuntimeLinearRead')) return {data:{issue:vars.id === issue?.id ? issue : null}};
    if (query.includes('query RuntimeLinearState')) {
      return {data:{workflowState:{id:vars.id,type:'completed',team:{id:linearScope.teamId}}}};
    }
    const {input} = vars;
    if (query.includes('mutation RuntimeLinearCreate')) {
      writes.push({operation:'create',id:input.id});
      issue = {id:input.id,title:input.title,description:input.description,archivedAt:null,
        team:{id:input.teamId},project:{id:input.projectId},state:{id:input.stateId,type:'unstarted'}};
      return {data:{issueCreate:{success:true,issue:{id:issue.id}}}};
    }
    assert(query.includes('mutation RuntimeLinearUpdate'));
    assert.equal(vars.id,issue.id);
    writes.push({operation:'update',id:vars.id,stateId:input.stateId});
    issue = {...issue,description:input.description,state:{id:input.stateId,type:'completed'}};
    return {data:{issueUpdate:{success:true,issue:{id:issue.id}}}};
  }});
  return {scope:linearScope,adapter,writes};
}

function githubFixture() {
  const repoPath = '/repos/'+repository;
  const repo = {id:21,full_name:repository,archived:false,disabled:false,allow_rebase_merge:true};
  const pending = {status:'pending',details:{uuid:operationId,expected_head_sha:repairedHead,
    merge_method:'rebase',merge_action:'direct_merge',bypass_rules:false}};
  let head = initialHead, merged = false;
  const writes = [], polls = [];
  const compare = tip => ({status:'ahead',behind_by:0,ahead_by:1,total_commits:1,base_commit:{sha:base},
    merge_base_commit:{sha:base},commits:[{sha:tip,parents:[{sha:base}],commit:{tree:{sha:tree}}}]});
  const binding = {
    repository,repositoryId:'21',baseBranch:'main',installationId:'104',installationCredentialRef:'vault:fixture-merge',
    actorId:'399',actorLogin:'preview-runtime[bot]',allowedPaths:['docs/feedback.md'],
  };
  const adapter = createFeedbackGitHubAdapter(binding,async () => 'fixture-token',async (input,init) => {
    const url = new URL(input);
    assert.equal(url.origin,'https://api.github.com');
    const path = url.pathname+url.search;
    const send = (value,status=200) => Response.json(value,{status,headers:{'x-github-request-id':'FIXTURE:REQUEST'}});
    if (init.method === 'PUT') {
      writes.push({path,input:JSON.parse(init.body)});
      return send(pending,202);
    }
    if (path === '/installation/repositories?per_page=2') return send({total_count:1,repositories:[repo]});
    assert(path.startsWith(repoPath));
    switch (path.slice(repoPath.length)) {
      case '': return send(repo);
      case '/branches/main': return send({name:'main',protected:true,commit:{sha:merged ? landedSha : base}});
      case '/branches/main/protection': return send({
        enforce_admins:{enabled:true},allow_force_pushes:{enabled:false},allow_deletions:{enabled:false},
        required_pull_request_reviews:{bypass_pull_request_allowances:{apps:[],users:[],teams:[]}},
      });
      case '/branches/main/protection/required_status_checks': return send({strict:true,contexts:['require-ci']});
      case '/rules/branches/main?per_page=100': return send([]);
      case '/pulls/5/files?per_page=100': return send([{filename:'docs/feedback.md',status:'modified'}]);
      case '/pulls/5': return send({
        number:5,state:merged ? 'closed' : 'open',merged,draft:false,auto_merge:null,mergeable:true,rebaseable:true,
        mergeable_state:'clean',changed_files:1,base:{ref:'main',repo,sha:base},head:{ref:pr.branch,repo,sha:head},
        ...(merged ? {merge_commit_sha:landedSha,merged_by:{type:'Bot',id:399,login:binding.actorLogin}} : {}),
      });
      case '/pulls/5/merge-async/'+operationId:
        polls.push(operationId);
        return send(merged ? {status:'merged',details:{sha:landedSha}} : pending);
      case '/compare/'+base+'...'+repairedHead: return send(compare(repairedHead));
      case '/compare/'+base+'...'+landedSha: return send(compare(landedSha));
      default: return assert.fail('Unexpected GitHub fixture route '+path);
    }
  });
  return {adapter,writes,polls,repair() {head = repairedHead;},finish() {merged = true;}};
}

function cursorFixture(github,clock,readAttempt) {
  const agents = new Map(), launches = [];
  let readbackAvailable = false;
  const adapter = createCursorAgentAdapter(cursorScope,{async request(operation) {
    if (operation.kind === 'launch') {
      const {prompt,agentId,...settings} = operation.body;
      const round = launches.length;
      const attempt = readAttempt(round);
      assert.equal(attempt.intent.agentId,agentId);
      assert(prompt.text);
      const runId = 'run-00000000-0000-0000-0000-00000000000'+(round+1);
      const agent = {id:agentId,...settings,latestRunId:runId,status:'IDLE'};
      const time = new Date(clock()-4_000).toISOString();
      const run = {id:runId,agentId,status:'FINISHED',createdAt:time,updatedAt:time,result:'Fixture repair output',
        git:{branches:[{repoUrl:cursorScope.repository.slice(8),branch:pr.branch,...(!round ? {prUrl:pr.url} : {})}]}};
      agents.set(agentId,{agent,run});
      launches.push({attempt,body:operation.body,runId});
      if (round) github.repair();
      if (!round) throw Error('Fixture lost the original Cursor launch response');
      return {agent,run};
    }
    if (!readbackAvailable) throw Error('Fixture Cursor readback unavailable');
    const {agent,run} = agents.get(operation.agentId);
    if (operation.kind === 'agent') return agent;
    if (operation.kind === 'runs') return {items:[run]};
    assert.equal(operation.runId,run.id);
    return run;
  }});
  return {scope:cursorScope,adapter,launches,enableReadback() {readbackAvailable = true;}};
}

function verificationFixture(clock,expiresAt,onExecutionRead) {
  const rule = {
    bindingRef:'binding:harness/feedback-quality',ownerRegistrationDigest:nativeSha256('fixture-harness-registration'),
    publicationRequestId:'fixture-publication',toolchainLockDigest:nativeSha256('fixture-toolchain'),
    effectiveConfigDigest:nativeSha256('fixture-config'),executorRef:'binding:executor/functional-verifier',
    executorBindingDigest:nativeSha256('fixture-verifier-registration'),validUntil:expiresAt,
    scope:{projectId,visibility:'private'},reference:{product:'harness',id:'feedback-check',version:'1.0.0',specVersion:'v1',
      visibility:'private',digest:nativeSha256('rule'),standardDigest:nativeSha256('standard'),standardLockDigest:nativeSha256('lock'),
      producer:{product:'harness',version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST},
  };
  const publishedPackage = {manifest:{entrypoints:{coverage:'coverage.json'}},
    files:{'coverage.json':JSON.stringify({requirements:[{id:'H001',caseIds:['functional']}]})}};
  const baseline = {reference:rule.reference,effectiveConfigDigest:rule.effectiveConfigDigest,
    executionStatus:'SUCCEEDED',qualityStatus:'PASS'};
  const receipts = new Map([[rule.publicationRequestId,{
    operation:'native.package.publish',requestId:rule.publicationRequestId,status:'SUCCEEDED',scope:rule.scope,
    result:{published:true,reference:rule.reference},
  }]]);
  const observations = [];
  const owner = {
    owner:'harness',workspaceId,capabilities:() => ({registrationDigest:rule.ownerRegistrationDigest}),
    async readPackage() {
      return {published:true,workspaceId,scope:rule.scope,reference:rule.reference,package:publishedPackage,
        validation:{...baseline,reportDigest:nativeSha256(baseline)}};
    },
    async read(_actor,project,request) {
      assert.equal(project,projectId);
      assert.equal(request.operation,'native.receipt.inspect');
      return structuredClone(receipts.get(request.input.requestId));
    },
  };
  const verifier = createFeedbackVerification({source:'FIXTURE',owner,async readExecution(_actor,subject,requestId) {
    assert.equal(requestId,feedbackVerificationExecutionId(subject));
    const status = subject.pullRequest.head === initialHead ? 'FAIL' : 'PASS';
    observations.push({status,subject});
    const execution = {schema:'runtime-feedback-verification-execution/v1',source:'FIXTURE',subjectDigest:subject.subjectDigest,
      requestId,executorRef:rule.executorRef,executorBindingDigest:rule.executorBindingDigest,executionId:'fixture-execution-'+requestId,
      startedAt:clock()-2_000,completedAt:clock()-1_000,expiresAt,receiptRef:'fixture:execution/'+requestId,
      receiptDigest:nativeSha256({requestId,status}),reportDigest:nativeSha256({requestId,result:status}),status};
    const {request,action,pin} = prepareFeedbackVerificationEvaluation(subject,execution,publishedPackage);
    const criteria = pin.criteria.map(criterion => ({...criterion,status,evidenceDigest:nativeSha256(criterion)}));
    const report = {schema:'evopilot-native-validation/v1',owner:'harness',context:action.context,
      toolchainLockDigest:rule.toolchainLockDigest,effectiveConfigDigest:rule.effectiveConfigDigest,reference:rule.reference,
      qualityStatus:status,executionStatus:'SUCCEEDED',observationDigest:action.observationDigest,criteria,rawReports:[]};
    receipts.set(request.requestId,{requestId:request.requestId,operation:request.operation,scope:request.scope,status:'SUCCEEDED',
      requestDigest:nativeSha256({operation:request.operation,scope:request.scope,input:request.input}),
      result:{...report,reportDigest:nativeSha256(report)}});
    onExecutionRead?.();
    return execution;
  }});
  return {rule,verifier,observations};
}

async function sendFeedback(listener,key,message) {
  const body = JSON.stringify(message);
  const timestamp = String(Date.now());
  const signature = 'sha256='+createHmac('sha256',key).update(timestamp+'.').update(body).digest('hex');
  const response = await fetch(listener.url+'/feedback',{
    method:'POST',body,headers:{'content-type':'application/json',
      'x-runtime-callback-timestamp':timestamp,'x-runtime-callback-signature':signature},
  });
  return {status:response.status,value:await response.json()};
}

test('the registered feedback worker repairs the original PR and closes the original issue and thread', async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-v010-integrated-workflow-'));
  const stateRoot = join(root,'runtime'), peerRoot = join(root,'channel-peer');
  mkdirSync(stateRoot,{mode:0o700});
  mkdirSync(peerRoot,{mode:0o700});
  const actor = {id:'worker',projects:[projectId],permissions:['read','execution.request'],
    revision:1,expiresAt:'2099-01-01T00:00:00Z'};
  const principal = () => actor;
  const feedbackKey = randomBytes(32), reviewKey = randomBytes(32), deliveryKey = randomBytes(32);
  const original = {schema:'runtime-feedback-channel-event/v1',scope,eventId:'callback-event',messageId:'thread-root',
    actorId:'reporter',action:{kind:'feedback',text:'The report loses its label when exported.'}};
  let now = Date.now();
  t.mock.method(Date,'now',() => now);
  const expiresAt = now + 7_200_000;
  let store, peer, listener, inbox, channel;
  try {
    store = new RuntimeStore(stateRoot,workspaceId);
    peer = new RuntimeStore(peerRoot,'channel-peer');
    inbox = await startReferenceDeliveryInbox({store:peer,projectId,scope,key:deliveryKey,principal});
    const deliveryRequests = [];
    channel = createReferenceDeliveryAdapter(inbox.url,scope,deliveryKey,async (url,init) => {
      const intent = JSON.parse(init.body);
      deliveryRequests.push({path:url.pathname,kind:intent.kind});
      const response = await fetch(url,init);
      if (url.pathname === '/deliver' && intent.kind === 'review') {
        assert.equal(response.status,201);
        await response.arrayBuffer();
        throw Error('Fixture lost the signed review delivery response');
      }
      return response;
    });
    listener = await startReferenceChannel({store,receiverPrincipal:principal,
      feedback:{key:feedbackKey,route},review:{key:reviewKey,route:reviewScope}});
    assert.equal((await sendFeedback(listener,reviewKey,original)).status,401);
    const retained = await sendFeedback(listener,feedbackKey,original);
    assert.equal(retained.status,201);
    const {caseId} = retained.value;
    await listener.close();
    listener = null;

    const read = (kind,id) => store.object(projectId,kind,id);
    const feedbackBindingStamp = digest('fixture callback and provider configuration');
    const activation = {workspaceId,projectId,serviceId:store.serviceId,feedbackBindingStamp,
      definitionPointer:digest(read('definition-pointer','active'))};
    const activationId = 'sha256:'+digest(activation);
    store.mutate(actor,{
      projectId,operation:'fixture.feedback.activation',requestId:'fixture-activation',
      expectedRevision:store.revision(projectId),permission:'execution.request',input:{},
    },() => ({value:{},event:{type:'fixture-feedback-activation',data:{}},objects:[
      {kind:'feedback-activation',id:activationId,value:{subject:activation,candidateDigest:activationId,validUntil:expiresAt}},
      {kind:'feedback-activation-pointer',id:'current',value:activationId},
    ]}));
    const attemptId = round => 'feedback-cursor:'+digest({caseId,round});
    const readAttempt = round => read('feedback-cursor-attempt',attemptId(round));
    const linear = linearFixture();
    const github = githubFixture();
    const cursor = cursorFixture(github,Date.now,readAttempt);
    let admitted = true, revokeDuringVerification = false;
    const verification = verificationFixture(Date.now,expiresAt,() => {
      if (revokeDuringVerification) admitted = false;
    });
    const grant = subject => ({subjectDigest:digest(subject),expiresAt});
    const permits = [];
    let receiptCoverage = 'COMPLETE';
    const registration = {
      workspaceId,projectId,activationId,feedbackBindingStamp,caseId,principalId:actor.id,principal,maxRepairs:1,
      admit:subject => admitted ? grant(subject) : null,
      triage:async subject => {
        assert.equal(subject.originalEvent.messageId,original.messageId);
        assert.deepEqual(subject.originalEvent.action,original.action);
        assert.equal(subject.issueReceiptDigest,digest(read('feedback-case-issue',caseId)));
        return {...grant(subject),status:'READY',evidenceRef:'fixture:triage/ready'};
      },
      linear,channel:{scope,adapter:channel},
      cursor:{scope:cursor.scope,adapter:cursor.adapter,permits:(subject,trigger) => {
        permits.push({subject,trigger});
        return {...grant(subject),evidenceRef:'fixture:cursor/round-'+subject.round,maxRepairs:1,
          prompt:subject.round ? 'Repair the original PR.' : 'Reproduce the export label defect.'};
      }},
      verification:{rule:verification.rule,verifier:verification.verifier,
        readCandidate:(selection,signal) => github.adapter.readCandidate(String(selection.run.pullRequest.number),signal)},
      review:{scope:reviewScope,adapter:github.adapter,currentPolicy:subject => ({
        ...grant(subject),policyDigest:digest('fixture review policy'),receiptCoverage,
      })},
    };
    let worker = createFeedbackWorkflowWorker(store,registration);
    const restart = () => {
      store.close();
      store = new RuntimeStore(stateRoot,workspaceId);
      worker = createFeedbackWorkflowWorker(store,registration);
    };
    const tick = async expected => {
      const state = await worker.runOnce();
      const progress = read('feedback-case-progress',caseId);
      assert.equal(state.phase,expected,JSON.stringify(progress?.timeline.at(-1)));
      assert.equal(state.caseId,caseId);
      return state;
    };

    await tick('issue');
    await tick('triage');
    const issue = read('feedback-case-issue',caseId);
    assert.equal(issue.source,'FIXTURE');
    await tick('work');
    await tick('work');
    assert.equal(readAttempt(0).outcome.status,'UNKNOWN');
    assert.equal(cursor.launches.length,1);
    const originalRunId = cursor.launches[0].runId;
    restart();
    cursor.enableReadback();
    const verify = await tick('verify');
    assert.equal(readAttempt(0).runId,originalRunId);
    assert.equal(cursor.launches.length,1);

    revokeDuringVerification = true;
    await assert.rejects(worker.runOnce(),{code:'FEEDBACK_WORKER_ADMISSION'});
    assert.equal(read('feedback-verification-latest',attemptId(0)),null);
    assert.deepEqual(read('feedback-workflow',activationId),verify);
    assert.equal(cursor.launches.length,1);
    admitted = true;
    revokeDuringVerification = false;
    const repair = await tick('work');
    assert.equal(repair.round,1);
    assert.equal(repair.trigger.kind,'verification');
    await tick('verify');
    const repairRunId = cursor.launches[1].runId;
    assert.equal(readAttempt(1).intent.original.runId,originalRunId);
    assert.equal(readAttempt(1).subject.previousRunId,originalRunId);
    assert.equal(readAttempt(1).runId,repairRunId);
    assert.notEqual(repairRunId,originalRunId);
    assert.equal(readAttempt(1).intent.issueId,issue.issueId);
    assert.equal(permits.at(-1).trigger.digest,repair.trigger.digest);
    assert.deepEqual(cursor.launches[1].body.repos,[{url:cursorScope.repository,prUrl:pr.url}]);
    const notify = await tick('notify');
    assert.equal(verification.observations.length,3);
    assert.deepEqual(verification.observations[0],verification.observations[1]);
    assert.deepEqual(verification.observations.slice(1).map(({status,subject}) => ({
      status,head:subject.pullRequest.head,number:subject.pullRequest.number,
      original:subject.original.run.runId,run:subject.work.run.runId,issueId:subject.issueId,
    })),[
      {status:'FAIL',head:initialHead,number:5,original:originalRunId,run:originalRunId,issueId:issue.issueId},
      {status:'PASS',head:repairedHead,number:5,original:originalRunId,run:repairRunId,issueId:issue.issueId},
    ]);
    assert.equal(notify.review.candidate.head,repairedHead);

    await tick('notify');
    assert.equal(peer.revision(projectId),1);
    restart();
    const reviewing = await tick('review');
    const {windowId} = reviewing.review;
    const window = read('feedback-review-window',windowId);
    assert.equal(window.candidate.head,repairedHead);
    assert.equal(window.deadline,window.openedAt+3_600_000);
    now = window.deadline-1;
    await tick('review');
    assert.deepEqual(github.writes,[]);
    assert.equal(read('feedback-review-window',windowId).claim,null);
    now = window.deadline;
    receiptCoverage = 'UNCERTAIN';
    await tick('review');
    assert.deepEqual(github.writes,[]);
    assert.equal(read('feedback-review-window',windowId).claim,null);
    receiptCoverage = 'COMPLETE';
    await tick('review');
    const {claim} = read('feedback-review-window',windowId);
    const pending = read('feedback-merge-outcome',claim.requestId);
    assert.equal(pending.status,'PENDING');
    assert.equal(pending.operationId,operationId);
    assert.equal(linear.writes.length,1);
    assert.equal(peer.revision(projectId),1);

    restart();
    github.finish();
    await tick('close-issue');
    const merged = read('feedback-merge-outcome',claim.requestId);
    assert.equal(merged.status,'MERGED');
    assert.equal(merged.mergeSha,landedSha);
    assert.equal(merged.operationId,pending.operationId);
    assert.deepEqual(github.polls,[operationId]);
    await tick('close-thread');
    const changeId = read('feedback-case-issue-latest',caseId);
    assert.equal(read('feedback-case-issue-change',changeId).result.receipt.issueId,issue.issueId);
    const complete = await tick('complete');
    const messages = peer.objectsPage(projectId,'feedback-reference-message').map(({value}) => value);
    const notice = messages.find(message => message.kind === 'review');
    assert.equal(notice.reviewId,windowId);
    const closure = messages.find(message => message.kind === 'closed');
    assert.equal(closure.requestId,complete.ref);
    assert.equal(closure.caseId,caseId);
    assert.equal(closure.originalMessageId,original.messageId);
    assert.match(closure.text,new RegExp(landedSha+'\\.$'));
    const progress = read('feedback-case-progress',caseId);
    assert.deepEqual(progress.visited,['receive','issue','reproduce','repair','verify','review','close']);
    assert(progress.timeline.some(entry => entry.stage === 'repair' && entry.returnFrom === 'verify'));
    assert.equal(progress.status,'COMPLETE');

    restart();
    assert.deepEqual(await tick('complete'),complete);
    assert.equal(peer.revision(projectId),2);
    assert.equal(cursor.launches.length,2);
    assert.deepEqual(linear.writes,[{operation:'create',id:issue.issueId},
      {operation:'update',id:issue.issueId,stateId:linearScope.closedStateId}]);
    assert.deepEqual(github.writes,[{path:'/repos/'+repository+'/pulls/5/merge-async',
      input:{sha:repairedHead,merge_method:'rebase',merge_action:'direct_merge',bypass_rules:false}}]);
    assert.deepEqual(deliveryRequests,[{path:'/deliver',kind:'review'},{path:'/inspect',kind:'review'},
      {path:'/deliver',kind:'closed'}]);
  } finally {
    channel?.close();
    await listener?.close();
    await inbox?.close();
    store?.close();
    peer?.close();
    rmSync(root,{recursive:true,force:true});
  }
});
