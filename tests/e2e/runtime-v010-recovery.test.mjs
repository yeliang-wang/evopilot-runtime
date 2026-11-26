import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createCursorAgentAdapter} from '../../dist/feedback-loop/cursor.js';
import {createFeedbackGitHubAdapter} from '../../dist/feedback-loop/github.js';
import {retainFeedbackChannelEvent} from '../../dist/feedback-loop/ingress.js';
import {createLinearIssueAdapter} from '../../dist/feedback-loop/linear.js';
import {
  reserveFeedbackReviewNotification, retainFeedbackProgress, retainFeedbackReview, retainFeedbackVeto,
} from '../../dist/feedback-loop/service.js';
import {normalizeSlackSocketModeEvent} from '../../dist/feedback-loop/slack.js';
import {createFeedbackWorkflowWorker} from '../../dist/feedback-loop/worker.js';
import {digest} from '../../dist/server/errors.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {RuntimeStore} from '../../dist/server/store.js';

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
