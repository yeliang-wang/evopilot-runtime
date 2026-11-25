import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {retainFeedbackChannelEvent} from '../../dist/feedback-loop/ingress.js';
import {
  reserveFeedbackReviewNotification, retainFeedbackProgress, retainFeedbackReview, retainFeedbackVeto,
} from '../../dist/feedback-loop/service.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {RuntimeStore} from '../../dist/server/store.js';

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
