import assert from 'node:assert/strict';
import test from 'node:test';
import { claimFeedbackMerge, feedbackReviewId, openFeedbackReview, recordFeedbackVeto } from '../../dist/feedback-loop/review.js';

const candidate = {
  workspaceId:'demo', projectId:'tasks', repositoryId:'21', pullRequestId:'5',
  head:'a'.repeat(40), base:'b'.repeat(40), evidenceDigest:'c'.repeat(64), policyDigest:'d'.repeat(64),
};
const start = 1_800_000_000_000;
const fixture = () => openFeedbackReview(candidate, 'intent-5', 'notice-5', start);
const observed = window => ({
  candidate, now:window.deadline, policyCurrent:true, receiptCoverage:'COMPLETE',
  githubChecksPassed:true, baseProtected:true,
});
test('window lasts sixty full minutes and a retained claim requires reconciliation', () => {
  const window = fixture();
  assert.equal(window.deadline - window.openedAt, 3_600_000);
  assert.throws(() => claimFeedbackMerge(window, {...observed(window), now:window.deadline - 1}), {code:'FEEDBACK_REVIEW_WAITING'});
  const claimed = claimFeedbackMerge(window, observed(window));
  assert.equal(claimed.claim.claimedAt, window.deadline);
  assert.throws(() => claimFeedbackMerge(claimed, observed(window)), {code:'FEEDBACK_RECONCILE_ORIGINAL'});
});
test('an authenticated veto recorded before cutoff blocks the original candidate', () => {
  const window = fixture();
  const action = {windowId:window.id, actorRef:'authorized-reviewer', eventKey:'original-event', receivedAt:window.deadline-1};
  const vetoed = recordFeedbackVeto(window, action);
  assert.equal(recordFeedbackVeto(vetoed, action), vetoed);
  assert.throws(() => claimFeedbackMerge(vetoed, observed(window)), {code:'FEEDBACK_REVIEW_VETO'});
  assert.throws(() => recordFeedbackVeto(window, {...action, receivedAt:window.deadline}), {code:'FEEDBACK_REVIEW_CLOSED'});
  assert.throws(() => recordFeedbackVeto(window, {...action, windowId:'old-window'}), {code:'FEEDBACK_REVIEW_CLOSED'});
});
test('changed candidate, uncertain coverage, invalid authority or failed GitHub guards block merging', () => {
  const window = fixture();
  for (const change of [
    {candidate:{...candidate, head:'e'.repeat(40)}}, {candidate:{...candidate, base:'f'.repeat(40)}},
    {receiptCoverage:'UNCERTAIN'}, {policyCurrent:false}, {githubChecksPassed:false}, {baseProtected:false},
  ]) {
    assert.throws(() => claimFeedbackMerge(window, {...observed(window), ...change}), {code:'FEEDBACK_MERGE_BLOCKED'});
  }
});

test('veto and merge share durable state; stale notification, duplicate delivery and restart are safe', async () => {
  const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { RuntimeStore } = await import('../../dist/server/store.js');
  const { retainFeedbackReview, retainFeedbackVeto, reserveFeedbackMerge, reserveFeedbackReviewNotification } = await import('../../dist/feedback-loop/service.js');
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-v010-review-'));
  const actor = {id:'operator',projects:['tasks'],permissions:['execution.request'],revision:1,expiresAt:'2099-01-01T00:00:00Z'};
  const scope = {
    workspaceId:'demo',projectId:'tasks',allowedActorIds:['reviewer'],
    channel:{provider:'callback',installationId:'adapter',tenantId:'team',channelId:'review-channel'},
  };
  let store = new RuntimeStore(root, 'demo');
  try {
    assert.throws(() => retainFeedbackReview(store, actor, scope, candidate, 'unreserved', 'notice-5', start), {code:'FEEDBACK_REVIEW_NOTIFICATION_UNRESERVED'});
    const reservation = reserveFeedbackReviewNotification(store,actor,scope,candidate);
    assert.equal(reservation.status,'RESERVED');
    const {intentRef} = reservation.intent;
    store.close();
    store = new RuntimeStore(root, 'demo');
    assert.deepEqual(reserveFeedbackReviewNotification(store,actor,scope,candidate),{...reservation,status:'REUSED'});
    const window = retainFeedbackReview(store, actor, scope, candidate, intentRef, 'notice-5', start);
    assert.equal(window.id, feedbackReviewId(candidate, intentRef));
    assert.deepEqual(retainFeedbackReview(store, actor, scope, candidate, intentRef, 'notice-5', start + 2000), window);
    assert.throws(() => retainFeedbackReview(store, actor, scope, candidate, 'other-intent', 'notice-5', start + 2000), {code:'FEEDBACK_REVIEW_NOTIFICATION_CONFLICT'});
    const original = {
      schema:'runtime-feedback-channel-event/v1',scope:scope.channel,eventId:'veto-1',messageId:'notice-5',
      actorId:'reviewer',action:{kind:'veto',reviewId:window.id},
    };
    assert.throws(() => retainFeedbackVeto(store, actor, scope, {...original,messageId:'other'}, () => start+1), {code:'FEEDBACK_REVIEW_FORBIDDEN'});
    const vetoed = retainFeedbackVeto(store, actor, scope, original, () => start+1);
    assert.equal(vetoed.veto.actorRef,'reviewer');
    store.close();
    store = new RuntimeStore(root, 'demo');
    assert.equal(retainFeedbackVeto(store, actor, scope, original, () => start+2).veto.eventKey,vetoed.veto.eventKey);
    assert.throws(() => reserveFeedbackMerge(store, actor, window.id, observed(window), () => window.deadline), {code:'FEEDBACK_REVIEW_VETO'});
    assert.throws(() => retainFeedbackReview(store, actor, scope, candidate, 'intent-retry', 'notice-retry', start+9), {code:'FEEDBACK_REVIEW_VETO'});
    const newCandidate = {...candidate,head:'e'.repeat(40)};
    const nextIntent = reserveFeedbackReviewNotification(store,actor,scope,newCandidate).intent;
    const next = retainFeedbackReview(store, actor, scope, newCandidate,nextIntent.intentRef,'notice-6',start+10);
    assert.throws(() => retainFeedbackVeto(store, actor, scope, {...original,eventId:'veto-2'},() => start+12), {code:'FEEDBACK_REVIEW_CLOSED'});
    assert.throws(() => retainFeedbackReview(store, actor, scope, candidate,'intent-reopened','notice-reopened',start+11), {code:'FEEDBACK_REVIEW_VETO'});
    const admission = {...observed(next),candidate:newCandidate};
    assert(reserveFeedbackMerge(store, actor, next.id, admission, () => next.deadline).claim);
    assert.throws(() => reserveFeedbackMerge(store, actor, next.id, admission, () => next.deadline), {code:'FEEDBACK_RECONCILE_ORIGINAL'});
    assert.equal(store.revision('tasks'),6);
  } finally {
    store.close();
    rmSync(root,{recursive:true,force:true});
  }
});

const githubRepoPath = '/repos/preview/demo-feedback';
const githubOperationId = '630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42';
const githubLandedSha = '9'.repeat(40);
const githubTreeSha = '1'.repeat(40);
const githubBinding = {
  repository:'preview/demo-feedback', repositoryId:'21', baseBranch:'main', installationId:'104',
  installationCredentialRef:'vault:preview-merge-installation', actorId:'399', actorLogin:'preview-runtime[bot]',
  allowedPaths:['docs/feedback.md','docs/replies.md'],
};
const githubRequest = {candidate,requestId:'feedback-merge:reserved-fixture'};

function githubCompare(base, tip, tree) {
  return {
    status:'ahead', behind_by:0, ahead_by:1, total_commits:1,
    base_commit:{sha:base}, merge_base_commit:{sha:base},
    commits:[{sha:tip,parents:[{sha:base}],commit:{tree:{sha:tree}}}],
  };
}

async function githubFixture() {
  const { createFeedbackGitHubAdapter } = await import('../../dist/feedback-loop/github.js');
  const repo = {id:21,full_name:'preview/demo-feedback',archived:false,disabled:false,allow_rebase_merge:true};
  const pending = {status:'pending',details:{uuid:githubOperationId,expected_head_sha:candidate.head,
    merge_method:'rebase',merge_action:'direct_merge'}};
  const target = {
    repo, pending, dispatchStatus:202, fault:false, rules:[],
    operation:{...pending,details:{...pending.details,bypass_rules:false}}, branchProtected:true, strictChecks:true,
    installationRepositories:[repo], bypass:{apps:[],users:[],teams:[]}, landedTree:githubTreeSha,
    files:[{filename:'docs/feedback.md',status:'modified'}],
    branchHead:candidate.base, verifiedBase:candidate.base, graphBase:candidate.base,
    pull:{number:5,state:'open',merged:false,draft:false,auto_merge:null,mergeable:true,rebaseable:true,mergeable_state:'clean',changed_files:1,
      base:{ref:'main',repo,sha:candidate.base},head:{ref:'fix/feedback',repo,sha:candidate.head}},
    requests:[],
  };
  function finish(actor = {type:'Bot',id:399,login:'preview-runtime[bot]'}) {
    target.branchHead = githubLandedSha;
    target.pull = {...target.pull, state:'closed', merged:true, merge_commit_sha:githubLandedSha, merged_by:actor};
    target.operation = {status:'merged',details:{sha:githubLandedSha}};
  }
  const token = 'fixture-token';
  function adapter(binding = githubBinding) {
    return createFeedbackGitHubAdapter(binding, async (registered, signal) => {
      assert.deepEqual(registered,binding);
      assert(signal instanceof AbortSignal);
      return token;
    }, async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin,'https://api.github.com');
      assert.equal(init.redirect,'error');
      assert.equal(init.headers.get('authorization'),`Bearer ${token}`);
      assert.equal(init.headers.get('x-github-api-version'),'2026-03-10');
      const path = url.pathname + url.search;
      target.requests.push({path,method:init.method});
      const send = (body,status=200) => Response.json(body,{status,headers:{'x-github-request-id':'AD12:EF01:9DC3'}});
      if (init.method === 'PUT') {
        assert.equal(path,`${githubRepoPath}/pulls/5/merge-async`);
        assert.deepEqual(JSON.parse(init.body),{sha:candidate.head,merge_method:'rebase',merge_action:'direct_merge',bypass_rules:false});
        if (target.fault) {
          finish();
          throw new Error('fixture connection lost after provider accepted the request');
        }
        return send(target.pending,target.dispatchStatus);
      }
      assert.equal(init.method,'GET');
      if (path === '/installation/repositories?per_page=2') return send({total_count:target.installationRepositories.length,repositories:target.installationRepositories});
      if (path === githubRepoPath) return send(target.repo);
      switch (path.slice(githubRepoPath.length)) {
        case '/branches/main/protection': return send({
          enforce_admins:{enabled:true}, allow_force_pushes:{enabled:false}, allow_deletions:{enabled:false},
          required_pull_request_reviews:{bypass_pull_request_allowances:target.bypass},
        });
        case '/branches/main/protection/required_status_checks': return send({strict:target.strictChecks,contexts:['require-ci']});
        case '/rules/branches/main?per_page=100': return send(target.rules);
        case '/branches/main': return send({name:'main',protected:target.branchProtected,commit:{sha:target.branchHead}});
        case '/pulls/5': return send({...target.pull,base:{...target.pull.base,sha:target.verifiedBase}});
        case '/pulls/5/files?per_page=100': return send(target.files);
        case `/pulls/5/merge-async/${githubOperationId}`: return send(target.operation, target.operation === null ? 404 : 200);
        case `/compare/${candidate.base}...${candidate.head}`: return send(githubCompare(candidate.base,candidate.head,githubTreeSha));
        case `/compare/${candidate.base}...${githubLandedSha}`: return send(githubCompare(target.graphBase,githubLandedSha,target.landedTree));
        default: throw new Error(`unexpected fixture route ${path}`);
      }
    });
  }
  return {target,adapter,finish,signal:new AbortController().signal};
}

test('GitHub dispatch uses the exact protected expected head and reconciles via the retained operation after restart', async () => {
  const {target,adapter,finish,signal} = await githubFixture();
  const observed = await adapter().inspect(candidate,signal);
  assert.deepEqual(observed,{candidate,bindingDigest:observed.bindingDigest,githubChecksPassed:true,baseProtected:true});
  const accepted = await adapter().dispatch(githubRequest,signal);
  assert.equal(accepted.source,'FIXTURE');
  assert.equal(accepted.status,'PENDING');
  assert.equal(accepted.operationId,githubOperationId);
  assert.equal(accepted.githubRequestId,'AD12:EF01:9DC3');
  assert.equal(accepted.mergeSha,null);
  assert.deepEqual(await adapter().reconcile(githubRequest,JSON.parse(JSON.stringify(accepted)),signal),accepted);
  finish();
  const merged = await adapter().reconcile(githubRequest,accepted,signal);
  assert.equal(merged.status,'MERGED');
  assert.equal(merged.mergeSha,githubLandedSha);
  assert.equal(merged.operationId,githubOperationId);
  assert.equal(target.requests.filter(request => request.method === 'PUT').length,1);
  await assert.rejects(adapter().reconcile({...githubRequest,requestId:'feedback-merge:another-claim'},accepted,signal),{code:'FEEDBACK_GITHUB_RECEIPT'});
  await assert.rejects(adapter({...githubBinding,installationId:'105'}).reconcile(githubRequest,accepted,signal),{code:'FEEDBACK_GITHUB_RECEIPT'});
});

test('independent verifier reads the exact protected PR head even while CI has not passed', async () => {
  const {target,adapter,signal} = await githubFixture();
  target.pull.mergeable_state = 'blocked';
  const binding = adapter();
  assert.deepEqual(await binding.readCandidate('5',signal),{
    source:'FIXTURE',repositoryId:'21',number:5,branch:'fix/feedback',head:candidate.head,base:candidate.base,
  });
  await assert.rejects(binding.inspect(candidate,signal),{code:'FEEDBACK_GITHUB_BLOCKED'});
  target.branchHead = '7'.repeat(40);
  await assert.rejects(binding.readCandidate('5',signal),{code:'FEEDBACK_GITHUB_BLOCKED'});
  assert.equal(target.requests.some(request=>request.method==='PUT'),false);
});

test('Runtime commits the merge claim, retains the original GitHub operation and reads it back after restart', async () => {
  const {mkdtempSync,realpathSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {RuntimeStore} = await import('../../dist/server/store.js');
  const {advanceFeedbackMerge,retainFeedbackReview,reserveFeedbackReviewNotification} = await import('../../dist/feedback-loop/service.js');
  const {target,adapter,finish,signal} = await githubFixture();
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-v010-merge-recovery-'));
  const actor = {id:'worker',projects:['tasks'],permissions:['execution.request'],revision:1,expiresAt:'2099-01-01T00:00:00Z'};
  const scope = {workspaceId:'demo',projectId:'tasks',allowedActorIds:['reviewer'],
    channel:{provider:'callback',installationId:'adapter',tenantId:'team',channelId:'review-channel'}};
  let store = new RuntimeStore(root,'demo');
  try {
    const {intent} = reserveFeedbackReviewNotification(store,actor,scope,candidate);
    const window = retainFeedbackReview(store,actor,scope,candidate,intent.intentRef,'notice-5',start);
    const ready = () => ({policyCurrent:true,receiptCoverage:'COMPLETE'});
    const advance = (time, admission = ready, reauthorize = () => actor) => advanceFeedbackMerge(
      store,actor,'tasks',window.id,adapter(),admission,reauthorize,signal,() => time,
    );
    await assert.rejects(advance(window.deadline-1),{code:'FEEDBACK_REVIEW_WAITING'});
    assert.equal(target.requests.length,0);
    await assert.rejects(advance(window.deadline,() => ({...ready(),policyCurrent:false})),{code:'FEEDBACK_MERGE_BLOCKED'});
    assert.equal(target.requests.filter(request => request.method==='PUT').length,0);
    assert.equal(store.object('tasks','feedback-review-window',window.id).claim,null);
    const observedClaims = [];
    const pending = await advance(window.deadline,() => {
      observedClaims.push(store.object('tasks','feedback-review-window',window.id).claim?.requestId ?? null);
      return ready();
    });
    assert.deepEqual(observedClaims,[null,pending.requestId]);
    assert.equal(pending.operationId,githubOperationId);
    assert.deepEqual(store.object('tasks','feedback-merge-outcome',pending.requestId),pending);
    store.close();
    store = new RuntimeStore(root,'demo');
    finish();
    const merged = await advance(window.deadline+1);
    assert.equal(merged.status,'MERGED');
    assert.equal(merged.source,'FIXTURE');
    assert.equal(merged.mergeSha,githubLandedSha);
    assert.equal(merged.requestId,pending.requestId);
    assert.equal(merged.operationId,pending.operationId);
    assert.equal(target.requests.filter(request => request.method==='PUT').length,1);
    await assert.rejects(advance(window.deadline+2,ready,() => ({...actor,revision:2})),{code:'AUTHORITY_CHANGED'});
    assert.equal(store.revision('tasks'),5);
  } finally {
    store.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('GitHub changed refs, unrelated repositories and insufficient protection prevent a mutation', async () => {
  for (const change of [
    target => { target.pull.head = {...target.pull.head,sha:'e'.repeat(40)}; },
    target => { target.verifiedBase = 'f'.repeat(40); },
    target => { target.branchHead = 'f'.repeat(40); },
    target => { target.branchProtected = false; },
    target => { target.strictChecks = false; },
    target => { target.pull.mergeable_state = 'blocked'; },
    target => { target.bypass.apps.push({id:212}); },
    target => { target.installationRepositories.push({id:22,full_name:'preview/other'}); },
    target => { target.rules = [{type:'merge_queue'}]; },
    target => { target.pull.stack = {number:1}; },
  ]) {
    const {target,adapter,signal} = await githubFixture();
    change(target);
    await assert.rejects(adapter().dispatch(githubRequest,signal),{code:'FEEDBACK_GITHUB_BLOCKED'});
    assert(target.requests.every(request => request.method === 'GET'));
  }
});

test('GitHub denies merge for changes outside the registered paths or incomplete file evidence', async () => {
  for (const files of [
    [{filename:'src/unreviewed.ts',status:'modified'}],
    [{filename:'docs/feedback.md',status:'renamed',previous_filename:'src/unreviewed.ts'}],
    [{filename:'docs/feedback.md',status:'renamed'}],
    [],
  ]) {
    const {target,adapter,signal} = await githubFixture();
    target.files = files;
    await assert.rejects(adapter().inspect(candidate,signal),{code:'FEEDBACK_GITHUB_BLOCKED'});
    await assert.rejects(adapter().dispatch(githubRequest,signal),{code:'FEEDBACK_GITHUB_BLOCKED'});
    assert(target.requests.every(request=>request.method==='GET'));
  }
});

test('GitHub denial, already-merged state and competing request do not prove the original operation', async () => {
  for (const [response,status] of [[403,'DENIED'],[200,'UNKNOWN'],[409,'UNKNOWN'],[503,'UNKNOWN']]) {
    const {target,adapter,signal} = await githubFixture();
    target.dispatchStatus = response;
    const result = await adapter().dispatch(githubRequest,signal);
    assert.equal(result.status,status);
    assert.equal(result.dispatchHttpStatus,response);
    assert.equal(result.mergeSha,null);
    assert.equal(result.operationId,null);
  }
  const {target,adapter,signal} = await githubFixture();
  const accepted = await adapter().dispatch(githubRequest,signal);
  target.operation = {status:'failed',details:{message:'Candidate no longer satisfies branch protection'}};
  target.pull.head = {...target.pull.head,sha:'e'.repeat(40)};
  assert.equal((await adapter().reconcile(githubRequest,accepted,signal)).status,'DENIED');
  assert.equal(target.requests.filter(request => request.method === 'PUT').length,1);
  const conflict = await githubFixture();
  conflict.target.pending.details.bypass_rules = true;
  const uncorrelated = await conflict.adapter().dispatch(githubRequest,conflict.signal);
  assert.equal(uncorrelated.status,'UNKNOWN');
  assert.equal(uncorrelated.operationId,null);
});

test('GitHub lost response, expired receipt, another merger and changed rebase contents remain unresolved', async () => {
  const lost = await githubFixture();
  lost.target.fault = true;
  const uncertain = await lost.adapter().dispatch(githubRequest,lost.signal);
  assert.equal(uncertain.status,'UNKNOWN');
  assert.equal(uncertain.operationId,null);
  assert.equal(uncertain.dispatchHttpStatus,null);
  for (const saved of [uncertain,null]) {
    const readback = await lost.adapter().reconcile(githubRequest,saved,lost.signal);
    assert.equal(readback.status,'UNKNOWN');
    assert.equal(readback.observedPullRequestMergeSha,githubLandedSha);
    assert.equal(readback.mergeSha,null);
  }
  assert.equal(lost.target.requests.filter(request => request.method === 'PUT').length,1);
  assert(!lost.target.requests.some(request => request.path.endsWith(githubOperationId)));

  for (const change of [
    fixture => { fixture.target.operation = null; },
    fixture => { fixture.finish({type:'User',id:402,login:'another-merger'}); },
    fixture => { fixture.target.landedTree = '2'.repeat(40); },
    fixture => { fixture.target.graphBase = 'f'.repeat(40); },
  ]) {
    const fixture = await githubFixture();
    const accepted = await fixture.adapter().dispatch(githubRequest,fixture.signal);
    fixture.finish();
    change(fixture);
    const readback = await fixture.adapter().reconcile(githubRequest,accepted,fixture.signal);
    assert.equal(readback.status,'UNKNOWN');
    assert.equal(readback.operationId,githubOperationId);
    assert.equal(readback.observedPullRequestMergeSha,githubLandedSha);
    assert.equal(readback.mergeSha,null);
    assert.equal(fixture.target.requests.filter(request => request.method === 'PUT').length,1);
  }
});
