import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,appendFileSync,readFileSync,symlinkSync,chmodSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {RuntimeStore} from '../../dist/server/store.js';
import {digest} from '../../dist/server/errors.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {metrics,zeroMetrics,unknownMetrics,BASE_STAGES} from '../../dist/usage/contract.js';
import {deriveDeltas,retainObservations,usageObjects} from '../../dist/usage/ledger.js';
import {createUsageService} from '../../dist/usage/service.js';
import {createUsageWorker} from '../../dist/usage/worker.js';
import {createUsageReport} from '../../dist/usage/reports.js';
import {inspectCodexSource,inspectCodexCursor,collectCodexUsage,readUsageGrant} from '../../dist/usage/codex.js';
import {installUsageGrant} from '../../dist/installation/usage.js';
import {compileLifecycle} from '../../dist/lifecycle/compiler.js';
import {pinInstance,requiredChecksDigest,requestStage,recordStageOutcome} from '../../dist/lifecycle/instance.js';
import {valueDigest} from '../../dist/lifecycle/base.js';
import {lifecycle,yaml,extension} from '../fixtures/lifecycle-v090.mjs';

const at=new Date(Date.now()-60000).toISOString(),expiresAt='2030-01-01T00:00:00Z';
const counts=(input,output,cachedInput=0,reasoningOutput=0)=>({input,output,total:input+output,cachedInput,cacheWriteInput:0,reasoningOutput});
const obs=(sequence,cumulative,last=unknownMetrics())=>({sequence,eventId:'event-'+sequence,observedAt:at,turnId:'turn-one',cumulative,last,model:'synthetic-model',provider:'synthetic-provider',provenanceDigest:digest({sequence,cumulative,last})});
const source=(baseline=zeroMetrics())=>({schema:'runtime-usage-source/v1',id:'source-one',projectId:'alpha',threadId:'thread-one',epoch:'epoch-one',baseline,baselineEvidence:'synthetic:zero',agentRole:'main',parentThreadId:null,principalId:'owner',principalRevision:1,grantDigest:'0'.repeat(64),registeredAt:at,revoked:false});
const recordOf=(v,recordedRevision=1)=>({...v,schema:'runtime-usage-observation/v1',sourceId:'source-one',epoch:'epoch-one',recordedRevision});
function fixture(){
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-usage-')),root=join(dir,'state'),token=randomBytes(32).toString('base64url');
  const actor={id:'owner',projects:['alpha'],permissions:['read','draft.write'],revision:1,expiresAt};
  initializeCredentials(root,'synthetic',[{...actor,tokenDigest:tokenDigest(token)}]);
  const store=new RuntimeStore(root,'synthetic'),service=createUsageService(store);
  const d=lifecycle();d.extensions=[extension('extra')];const definition=compileLifecycle(yaml(d),'alpha').effective,revisionId=valueDigest(definition.semantic);
  const authority={projectId:'alpha',instanceId:'instance-one',definitionRevisionId:revisionId,semanticDigest:definition.semanticDigest,goalRef:'synthetic:goal',targetRef:'synthetic:target',loopRef:'synthetic:loop',requirementsDigest:requiredChecksDigest(definition),budget:{timeoutSeconds:3600,maxAttempts:4,maxConcurrency:4,maxLoops:4},evidenceRef:'synthetic:authority',revision:'1',expiresAt};
  const instance=pinInstance('instance-one',revisionId,definition,authority);
  function save(kind,id,value,event={type:'synthetic-seed',data:{kind,id}}){return store.mutate(actor,{projectId:'alpha',operation:'synthetic.seed',requestId:randomBytes(12).toString('hex'),expectedRevision:store.revision('alpha'),input:{kind,id,digest:digest(value)},permission:'read'},()=>({objects:[{kind,id,value}],value:{kind,id},event}));}
  save('lifecycle-instance',instance.id,instance);
  const write=(op,input,requestId=randomBytes(12).toString('hex'))=>service.write(actor,'alpha',op,input,requestId,store.revision('alpha'),()=>actor);
  const bind=(overrides={})=>write('usage.attribution.bind',{id:'binding-one',sourceId:'source-one',afterSequence:0,throughSequence:null,targetVersion:'0.9.0',targetRef:'synthetic:target',instanceId:instance.id,stageId:'implementation',baseStage:'implementation',taskId:'task-one',attemptId:'attempt-one',workType:'coding',...overrides});
  const put=(path,value)=>writeFileSync(path,JSON.stringify(value),{mode:0o600});
  function grant({id='source-one',threadId='thread-one',baseline=zeroMetrics(),agentRole='main',parentThreadId=null,expiresAt:grantExpiry=expiresAt}={}){
    const path=join(dir,id+'.jsonl');writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id:threadId,cli_version:'0.166.0-synthetic',model_provider:'synthetic-provider',base_instructions:'SECRET_PROMPT_MUST_NOT_LEAK'}})+'\n',{mode:0o600});
    const grantRef=join(dir,id+'-grant.json'),value={schema:'runtime-codex-usage-grant/v1',id,workspaceId:'synthetic',projectId:'alpha',principalId:actor.id,principalRevision:actor.revision,path,identity:inspectCodexSource(path),epoch:'epoch-one',agentRole,parentThreadId,baseline,baselineEvidence:'synthetic:known-baseline',expiresAt:grantExpiry};
    put(grantRef,value);installUsageGrant(root,'synthetic',grantRef);write('usage.source.register',{sourceId:id});return{path,grantRef,value};
  }
  return{dir,root,store,service,actor,token,instance,authority,save,write,bind,put,grant,cleanup(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
function appendUsage(path,sequence,input,output){
  appendFileSync(path,JSON.stringify({type:'turn_context',payload:{turn_id:'turn-one',model:'synthetic-model'}})+'\n');
  const counters={input_tokens:input,output_tokens:output,total_tokens:input+output,cached_input_tokens:Math.floor(input/2),cache_write_input_tokens:0,reasoning_output_tokens:0};
  appendFileSync(path,JSON.stringify({type:'event_msg',ordinal:sequence,timestamp:at,payload:{type:'token_count',info:{total_token_usage:counters,last_token_usage:counters},rate_limits:{secret:'NEVER_COPY'}}})+'\n');
}

test('inclusive counts validate subsets without adding cached or reasoning tokens twice',()=>{
  const c=metrics(counts(100,20,80,10));assert.equal(c.total,120);
  for(const value of [{...c,total:210},{...c,cachedInput:101},{...c,reasoningOutput:21},{...c,output:-1}])assert.throws(()=>metrics(value),{code:'USAGE_METRIC'});
  assert.equal(metrics({...c,total:null}).total,120);
});
test('unknown metrics and inherited history never become fabricated zeros',()=>{
  const rows=deriveDeltas(source(unknownMetrics()),[recordOf(obs(1,counts(1000,100),counts(10,2)))],[]);
  assert.equal(rows[0].metrics.total,12);assert(rows[0].issues.includes('PARTIAL_HISTORY_total'));
  const missing=deriveDeltas(source(unknownMetrics()),[recordOf(obs(1,unknownMetrics()))],[]);assert.equal(missing[0].metrics.total,null);
});
test('retained cumulative replay and late/out-of-order events are normalized once',()=>{
  const f=fixture();try{
    const s=source();f.save('usage-source',s.id,s);f.bind();
    const retain=v=>retainObservations(f.store,f.actor,s,v,{last:v.at(-1).sequence},()=>f.actor);
    retain([obs(3,counts(300,30))]);const original=createUsageReport(f.store,'alpha',{targetVersion:'0.9.0'});assert.equal(original.counts.total.recorded,330);
    const saved=f.write('usage.snapshot.create',{targetVersion:'0.9.0'}).result.id, frozen=structuredClone(f.service.read(f.actor,'alpha','usage.snapshot.read',{id:saved}).report);
    retain([obs(1,counts(100,10)),obs(2,counts(200,20))]);retain([obs(3,counts(300,30))]);
    const latest=createUsageReport(f.store,'alpha',{targetVersion:'0.9.0'});assert.equal(latest.counts.total.recorded,330);assert.equal(latest.records,3);
    assert.deepEqual(f.service.read(f.actor,'alpha','usage.snapshot.read',{id:saved}).report,frozen);
  }finally{f.cleanup();}
});
test('source corrections and undeclared resets retain evidence without negative or invented counts',()=>{
  const rows=deriveDeltas(source(),[recordOf(obs(1,counts(100,10))),recordOf(obs(2,counts(20,2))),recordOf(obs(3,counts(130,13)))],[]);
  assert.equal(rows[1].metrics.total,null);assert(rows[1].issues.includes('RESET_OR_CORRECTION_total'));assert.equal(rows[2].metrics.total,33);
  const f=fixture();try{const s=source();f.save('usage-source',s.id,s);retainObservations(f.store,f.actor,s,[obs(1,counts(10,1))],{cursor:1},()=>f.actor);assert.throws(()=>retainObservations(f.store,f.actor,s,[obs(1,counts(20,2))],{cursor:1},()=>f.actor),{code:'USAGE_SOURCE_CORRECTION'});assert.equal([...usageObjects(f.store,'alpha','usage-observation')].length,1);}finally{f.cleanup();}
});
test('fork baseline excludes inherited cumulative counts and retains model/agent provenance',()=>{
  const missing=deriveDeltas({...source(unknownMetrics()),parentThreadId:'parent'},[recordOf(obs(1,counts(1000,100),counts(10,2))),recordOf(obs(2,counts(1050,105),counts(50,5)))],[]);
  assert.equal(missing[0].metrics.total,null);assert(missing[0].issues.includes('UNKNOWN_FORK_BASELINE_total'));assert.equal(missing[1].metrics.total,55);
  const f=fixture();try{const s={...source(counts(1000,100,800,10)),agentRole:'subagent',parentThreadId:'parent-thread'};f.save('usage-source',s.id,s);f.bind();retainObservations(f.store,f.actor,s,[obs(1,counts(1100,120,880,15))],{cursor:1},()=>f.actor);const report=createUsageReport(f.store,'alpha',{targetVersion:'0.9.0'});assert.equal(report.counts.total.recorded,120);assert.equal(report.counts.cachedInput.recorded,80);assert.equal(report.sources[0].parentThreadId,'parent-thread');assert.match(report.views.agent[0].key,/subagent/);assert.match(report.views.model[0].key,/synthetic-model/);}finally{f.cleanup();}
});
test('bindings reject project/Target/version drift, nonexistent instance and duplicate parallel allocation',()=>{
  const f=fixture();try{f.save('usage-source','source-one',source());
    assert.throws(()=>f.bind({targetRef:'other'}),{code:'USAGE_ATTRIBUTION_SCOPE'});assert.throws(()=>f.bind({instanceId:'missing'}),{code:'NOT_FOUND'});
    f.bind({throughSequence:20});assert.throws(()=>f.bind({id:'overlap',afterSequence:10,taskId:'parallel-two'}),{code:'USAGE_RANGE_OVERLAP'});
    assert.throws(()=>f.bind({id:'later-version',afterSequence:20,targetVersion:'0.10.0'}),{code:'USAGE_VERSION_DRIFT'});
    f.bind({id:'parallel-two',afterSequence:20,taskId:'parallel-two'});
    assert.equal([...usageObjects(f.store,'alpha','usage-attribution')].length,2);
  }finally{f.cleanup();}
});
test('explicit extension Base mapping cannot relabel Base nodes or change later',()=>{
  const f=fixture();try{f.save('usage-source','source-one',source());assert.throws(()=>f.bind({baseStage:'scope'}),{code:'USAGE_BASE_STAGE'});
    f.bind({stageId:'project.extra',baseStage:'plan',throughSequence:10});
    assert.throws(()=>f.bind({id:'changed-map',stageId:'project.extra',baseStage:'candidate',afterSequence:10}),{code:'USAGE_BASE_STAGE'});
  }finally{f.cleanup();}
});
test('range closure permits subsequent task attribution and retains immutable binding history',()=>{
  const f=fixture();try{const s=source();f.save('usage-source',s.id,s);f.bind();retainObservations(f.store,f.actor,s,[obs(10,counts(100,10))],{cursor:10},()=>f.actor);
    assert.throws(()=>f.write('usage.attribution.close',{bindingId:'binding-one',throughSequence:9}),{code:'USAGE_RANGE_HISTORY'});
    f.write('usage.attribution.close',{bindingId:'binding-one',throughSequence:10});f.bind({id:'testing',afterSequence:10,stageId:'verification',baseStage:'verification',workType:'testing'});
    retainObservations(f.store,f.actor,s,[obs(20,counts(150,15))],{cursor:20},()=>f.actor);
    const report=createUsageReport(f.store,'alpha',{targetVersion:'0.9.0'});assert.deepEqual(report.views.stage.map(x=>[x.key,x.counts.total.recorded]),[['implementation',110],['verification',55]]);
    assert.equal(f.store.object('alpha','usage-attribution','binding-one').throughSequence,null);
  }finally{f.cleanup();}
});
test('unclassified records remain visible and independent report views reconcile',()=>{
  const f=fixture();try{const s=source();f.save('usage-source',s.id,s);f.bind({throughSequence:1});retainObservations(f.store,f.actor,s,[obs(1,counts(100,10)),obs(2,counts(130,13))],{cursor:2},()=>f.actor);
    const report=createUsageReport(f.store,'alpha',{targetVersion:'0.9.0'});assert.equal(report.counts.total.recorded,110);assert.equal(report.unclassified.counts.total.recorded,33);assert.equal(report.completeVersionTotal,false);for(const rows of Object.values(report.views))assert.equal(rows.reduce((n,r)=>n+r.counts.total.recorded,0),110);
    assert.equal(createUsageReport(f.store,'alpha',{targetVersion:'missing'}).counts.total.recorded,null);
  }finally{f.cleanup();}
});
test('Codex reader retains only counters/metadata, resumes its exact offset and waits for complete records',()=>{
  const f=fixture();try{const g=f.grant();appendUsage(g.path,1,100,10);const first=collectCodexUsage(g.path,g.value.identity,null);assert.equal(first.observations.length,1);assert.equal(first.observations[0].cumulative.total,110);assert(!JSON.stringify(first).includes('SECRET'));assert(!JSON.stringify(first).includes('NEVER_COPY'));
    assert.equal(collectCodexUsage(g.path,g.value.identity,first.cursor).observations.length,0);
    appendFileSync(g.path,'{"type":"event_msg"');const incomplete=collectCodexUsage(g.path,g.value.identity,first.cursor);assert.equal(incomplete.cursor.offset,first.cursor.offset);assert.equal(incomplete.caughtUp,false);
  }finally{f.cleanup();}
});
test('Codex grants reject arbitrary files, symlinks, unsafe permissions and cross-principal scope',()=>{
  const f=fixture();try{const g=f.grant(),link=join(f.dir,'link.jsonl');symlinkSync(g.path,link);assert.throws(()=>inspectCodexSource(link),{code:'UNSAFE_USAGE_SOURCE'});chmodSync(g.path,0o644);assert.equal(inspectCodexSource(g.path).threadId,g.value.identity.threadId);chmodSync(g.path,0o666);assert.throws(()=>inspectCodexSource(g.path),{code:'UNSAFE_USAGE_SOURCE'});chmodSync(g.path,0o600);
    const auth=join(f.dir,'auth.jsonl');writeFileSync(auth,'{"token":"SYNTHETIC_SECRET"}\n',{mode:0o600});assert.throws(()=>inspectCodexSource(auth),{code:'USAGE_SOURCE_FORMAT'});
    f.put(g.grantRef,{...g.value,principalRevision:2});assert.throws(()=>installUsageGrant(f.root,'synthetic',g.grantRef),{code:'USAGE_SCOPE'});
    f.put(g.grantRef,{...g.value,id:'duplicate'});installUsageGrant(f.root,'synthetic',g.grantRef);assert.throws(()=>f.write('usage.source.register',{sourceId:'duplicate'}),{code:'USAGE_DUPLICATE_SOURCE'});
  }finally{f.cleanup();}
});
test('source truncation or replacement is explicit incomplete evidence, never implicit reset',()=>{
  const f=fixture();try{const g=f.grant();appendUsage(g.path,1,100,10);const first=collectCodexUsage(g.path,g.value.identity,null);writeFileSync(g.path,readFileSync(g.path,'utf8').split('\n')[0]+'\n');assert.throws(()=>collectCodexUsage(g.path,g.value.identity,first.cursor),{code:'USAGE_SOURCE_CHANGED'});}finally{f.cleanup();}
});
test('an explicit reset epoch cannot reread old bytes or operate alongside its predecessor',()=>{
  const f=fixture();let worker;try{
    const g=f.grant();f.bind();appendUsage(g.path,1,100,10);worker=createUsageWorker(f.store,()=>f.actor,60000);worker.tick();worker.close();
    const cursor=inspectCodexCursor(g.path,readFileSync(g.path).length),next={...g.value,id:'reset-source',epoch:'reset-two',predecessorId:'source-one',initialCursor:cursor};
    f.put(g.grantRef,next);installUsageGrant(f.root,'synthetic',g.grantRef);assert.throws(()=>f.write('usage.source.register',{sourceId:'reset-source'}),{code:'USAGE_EPOCH'});
    f.write('usage.source.revoke',{sourceId:'source-one'});f.write('usage.source.register',{sourceId:'reset-source'});f.bind({id:'reset-binding',sourceId:'reset-source',attemptId:'repair-two'});
    appendUsage(g.path,2,20,2);worker=createUsageWorker(f.store,()=>f.actor,60000);for(let i=0;i<5;i++)worker.tick();
    assert.equal(createUsageReport(f.store,'alpha',{targetVersion:'0.9.0'}).counts.total.recorded,132);
    const bad={...next,id:'overlapping-epoch',epoch:'reset-three',predecessorId:'reset-source',initialCursor:inspectCodexCursor(g.path,0)};f.put(g.grantRef,bad);installUsageGrant(f.root,'synthetic',g.grantRef);f.write('usage.source.revoke',{sourceId:'reset-source'});assert.throws(()=>f.write('usage.source.register',{sourceId:bad.id}),{code:'USAGE_EPOCH_OVERLAP'});
  }finally{worker?.close();f.cleanup();}
});
test('multiple chats, attempts and instances retain consumption exactly once in one version',()=>{
  const f=fixture();try{
    const first=source(),second={...source(),id:'source-two',threadId:'thread-two'};f.save('usage-source',first.id,first);f.save('usage-source',second.id,second);f.bind();
    const other=pinInstance('instance-two',f.instance.pins.definitionRevisionId,f.instance.definition,{...f.authority,instanceId:'instance-two'});f.save('lifecycle-instance',other.id,other);
    f.bind({id:'repair-binding',sourceId:second.id,instanceId:other.id,taskId:'repair',attemptId:'failed-attempt-two',workType:'review-repair'});
    retainObservations(f.store,f.actor,first,[obs(1,counts(100,10))],{cursor:1},()=>f.actor);retainObservations(f.store,f.actor,second,[obs(1,counts(50,5))],{cursor:1},()=>f.actor);
    const report=createUsageReport(f.store,'alpha',{targetVersion:'0.9.0'});assert.equal(report.counts.total.recorded,165);assert.equal(report.sources.length,2);assert.equal(report.views.instance.length,2);assert.equal(report.views.workType.find(r=>r.key==='review-repair').counts.total.recorded,55);
    assert.equal(createUsageReport(f.store,'alpha',{targetVersion:'0.9.0',instanceId:other.id}).counts.total.recorded,55);
  }finally{f.cleanup();}
});
test('native collection restart/replay and stopped-store backup preserve offsets and reports',()=>{
  const f=fixture();let worker;try{const g=f.grant();f.bind();appendUsage(g.path,1,100,10);worker=createUsageWorker(f.store,()=>f.actor,60000);worker.tick();const before=createUsageReport(f.store,'alpha',{targetVersion:'0.9.0'});assert.equal(before.counts.total.recorded,110);worker.close();f.store.close();
    const backup=join(f.dir,'backup');cpSync(f.root,backup,{recursive:true});chmodSync(backup,0o700);const restored=new RuntimeStore(backup,'synthetic');try{assert.equal(createUsageReport(restored,'alpha',{targetVersion:'0.9.0'}).counts.total.recorded,110);assert.ok(restored.object('alpha','usage-checkpoint','source-one'));}finally{restored.close();}
    const reopened=new RuntimeStore(f.root,'synthetic');try{worker=createUsageWorker(reopened,()=>f.actor,60000);worker.tick();assert.equal([...usageObjects(reopened,'alpha','usage-observation')].length,1);appendUsage(g.path,2,150,15);worker.tick();worker.tick();assert.equal(createUsageReport(reopened,'alpha',{targetVersion:'0.9.0'}).counts.total.recorded,165);}finally{worker.close();reopened.close();}
  }finally{worker?.close();f.cleanup();}
});
test('revocation prevents collection and scoped reads; it cannot change business state',()=>{
  const f=fixture();let worker;try{const g=f.grant();f.bind();appendUsage(g.path,1,100,10);const original=structuredClone(f.store.object('alpha','lifecycle-instance','instance-one'));worker=createUsageWorker(f.store,()=>({...f.actor,revision:2}),60000);worker.tick();assert.equal([...usageObjects(f.store,'alpha','usage-observation')].length,0);assert.equal(worker.health('alpha').error,'USAGE_AUTHORITY_CHANGED');assert.deepEqual(f.store.object('alpha','lifecycle-instance','instance-one'),original);
    assert.throws(()=>f.service.read({...f.actor,projects:['beta']},'alpha','usage.report.read',{targetVersion:'0.9.0'}),{code:'FORBIDDEN'});
    f.write('usage.source.revoke',{sourceId:'source-one'});worker.close();worker=createUsageWorker(f.store,()=>f.actor,60000);worker.tick();assert.equal([...usageObjects(f.store,'alpha','usage-observation')].length,0);
  }finally{worker?.close();f.cleanup();}
});
test('all Base completion events produce durable cumulative snapshots; reporting failure recovers without lifecycle mutations',()=>{
  const f=fixture();let worker;try{
    const g=f.grant();f.bind();appendUsage(g.path,1,100,10);
    // Native reducers create real state transitions under explicitly synthetic
    // adapter evidence. This exercises reporting, not provider acceptance.
    let instance=f.instance;const now=Date.now(),ctx={authority:f.authority,bindingsCurrent:true,now};
    const pending=[...instance.definition.nodes];while(pending.length){const index=pending.findIndex(n=>n.dependsOn.every(id=>instance.stages[id].status==='PASSED'));assert(index>=0);const [node]=pending.splice(index,1);
      const requestId='synthetic-stage-'+node.id;
      const context=node.id==='publication'?{...ctx,releaseAuthority:{projectId:'alpha',instanceId:instance.id,pinsDigest:instance.pinsDigest,definitionRevisionId:instance.pins.definitionRevisionId,requirementsDigest:instance.pins.requirementsDigest,semanticDigest:instance.pins.semanticDigest,candidateDigest:instance.candidateDigest,channel:'github-release',decisionRef:'synthetic:release',expiresAt}}:ctx;
      instance=requestStage(instance,node.id,requestId,context);
      const outcome={requestId,inputDigest:instance.stages[node.id].inputDigest,receiptRef:'synthetic:receipt/'+node.id,status:'COMPLETE',expiresAt,checks:node.checks.map(id=>({id,status:'PASS',evidenceRef:'synthetic:'+id}))};
      if(node.id==='candidate')outcome.candidate={schema:'runtime-candidate/v1',version:'0.9.0',profile:'candidate-verification',sourceDigest:valueDigest('source'),buildDigest:valueDigest('build'),artifacts:[{name:'test.tgz',digest:valueDigest('bytes'),bytes:5}]};
      instance=recordStageOutcome(instance,node.id,outcome,now);
      f.save('lifecycle-instance',instance.id,instance,{type:'stage-observed',data:{instanceId:instance.id,stageId:node.id,stageRequestId:requestId,phase:'COMPLETE'}});
    }
    const stable=structuredClone(instance),originalMutate=f.store.mutate.bind(f.store);let failed=false;
    f.store.mutate=(actor,request,...rest)=>{if(request.operation==='usage.snapshot.observed'&&!failed){failed=true;throw Error('synthetic disk outage');}return originalMutate(actor,request,...rest);};
    worker=createUsageWorker(f.store,()=>f.actor,60000);worker.tick();assert.equal(worker.health('alpha').error,'USAGE_REPORT_UNAVAILABLE');assert.deepEqual(f.store.object('alpha','lifecycle-instance',instance.id),stable);
    for(let i=0;i<12;i++)worker.tick();const snapshots=[...usageObjects(f.store,'alpha','usage-snapshot')];assert.equal(snapshots.length,8);assert.deepEqual(snapshots.map(s=>s.trigger.stageId).sort(),[...BASE_STAGES].sort());assert.equal(snapshots.find(s=>s.kind==='publication').report.counts.total.recorded,110);assert.equal(snapshots.find(s=>s.kind==='closure').report.counts.total.recorded,110);
    for(let i=0;i<6;i++)worker.tick();assert.equal([...usageObjects(f.store,'alpha','usage-snapshot')].length,8);assert.deepEqual(f.store.object('alpha','lifecycle-instance',instance.id),stable);
    const frozen=structuredClone(snapshots);appendUsage(g.path,2,150,15);for(let i=0;i<12;i++)worker.tick();
    const revisions=[...usageObjects(f.store,'alpha','usage-snapshot')];assert.equal(revisions.length,16);for(const old of frozen)assert.deepEqual(f.store.object('alpha','usage-snapshot',old.id),old);assert.equal(revisions.filter(s=>s.kind==='closure').sort((a,b)=>b.report.cutoffRevision-a.report.cutoffRevision)[0].report.counts.total.recorded,165);
  }finally{worker?.close();f.cleanup();}
});

function completeFixtureStages(f){
  let instance=f.instance;const now=Date.now(),ctx={authority:f.authority,bindingsCurrent:true,now},pending=[...instance.definition.nodes];
  while(pending.length){
    const index=pending.findIndex(n=>n.dependsOn.every(id=>instance.stages[id].status==='PASSED'));assert(index>=0);const [node]=pending.splice(index,1),requestId='completion-'+node.id;
    const context=node.id==='publication'?{...ctx,releaseAuthority:{projectId:'alpha',instanceId:instance.id,pinsDigest:instance.pinsDigest,definitionRevisionId:instance.pins.definitionRevisionId,requirementsDigest:instance.pins.requirementsDigest,semanticDigest:instance.pins.semanticDigest,candidateDigest:instance.candidateDigest,channel:'github-release',decisionRef:'synthetic:release',expiresAt}}:ctx;
    instance=requestStage(instance,node.id,requestId,context);
    const outcome={requestId,inputDigest:instance.stages[node.id].inputDigest,receiptRef:'synthetic:receipt/'+node.id,status:'COMPLETE',expiresAt,checks:node.checks.map(id=>({id,status:'PASS',evidenceRef:'synthetic:'+id}))};
    if(node.id==='candidate')outcome.candidate={schema:'runtime-candidate/v1',version:'0.9.0',profile:'candidate-verification',sourceDigest:valueDigest('source'),buildDigest:valueDigest('build'),artifacts:[{name:'test.tgz',digest:valueDigest('bytes'),bytes:5}]};
    instance=recordStageOutcome(instance,node.id,outcome,now);
    f.save('lifecycle-instance',instance.id,instance,{type:'stage-observed',data:{instanceId:instance.id,stageId:node.id,stageRequestId:requestId,phase:'COMPLETE'}});
  }
  return instance;
}

test('continuous usage cannot starve any Base stage snapshot or its late revision',()=>{
  const f=fixture();let worker;try{
    const g=f.grant();f.bind();completeFixtureStages(f);worker=createUsageWorker(f.store,()=>f.actor,60000);
    for(let i=1;i<=16;i++){
      appendUsage(g.path,i,100*i,10*i);
      const before=[...usageObjects(f.store,'alpha','usage-snapshot')].length;worker.tick();
      assert([...usageObjects(f.store,'alpha','usage-snapshot')].length-before<=2,'Snapshot writes remain bounded per tick');worker.tick();
    }
    const all=[...usageObjects(f.store,'alpha','usage-snapshot')];
    assert.deepEqual([...new Set(all.map(s=>s.trigger.stageId))].sort(),[...BASE_STAGES].sort());
    for(const stage of BASE_STAGES)assert(all.filter(s=>s.trigger.stageId===stage).length>=2,'Every stage receives a later immutable revision during continuous traffic: '+stage);
  }finally{worker?.close();f.cleanup();}
});

test('revoking the last source stops file reads but preserves stage and closure reporting',()=>{
  const f=fixture();let worker;try{
    const g=f.grant();f.bind();appendUsage(g.path,1,100,10);worker=createUsageWorker(f.store,()=>f.actor,60000);worker.tick();
    f.write('usage.source.revoke',{sourceId:'source-one'});rmSync(g.path);
    const stable=completeFixtureStages(f);for(let i=0;i<20;i++)worker.tick();
    const snapshots=[...usageObjects(f.store,'alpha','usage-snapshot')];assert.equal(snapshots.length,8);
    assert.equal(snapshots.find(s=>s.kind==='publication').report.counts.total.recorded,110);
    assert.equal(snapshots.find(s=>s.kind==='closure').report.counts.total.recorded,110);
    assert.equal([...usageObjects(f.store,'alpha','usage-observation')].length,1);assert.deepEqual(f.store.object('alpha','lifecycle-instance',stable.id),stable);
  }finally{worker?.close();f.cleanup();}
});

test('an expired predecessor can supply immutable identity to a fresh grant without resuming expired collection',()=>{
  const f=fixture(),originalNow=Date.now,expiry=originalNow()+10000;let worker;try{
    const g=f.grant({expiresAt:new Date(expiry).toISOString()});f.bind();appendUsage(g.path,1,100,10);worker=createUsageWorker(f.store,()=>f.actor,60000);worker.tick();worker.close();
    Date.now=()=>expiry+1;
    assert.throws(()=>readUsageGrant(f.root,'synthetic','alpha','source-one'),{code:'USAGE_EXPIRED'});
    f.write('usage.source.revoke',{sourceId:'source-one'});
    const next={...g.value,id:'renewed-source',epoch:'renewed-two',predecessorId:'source-one',initialCursor:inspectCodexCursor(g.path,readFileSync(g.path).length),baseline:counts(100,10,50,0),expiresAt};
    f.put(g.grantRef,next);installUsageGrant(f.root,'synthetic',g.grantRef);
    // Historical inspection may not trust a replaced grant even after expiry.
    const originalGrant=join(f.root,'usage-grants/source-one.json');f.put(originalGrant,{...g.value,epoch:'tampered'});
    assert.throws(()=>f.write('usage.source.register',{sourceId:next.id}),{code:'USAGE_GRANT_CHANGED'});f.put(originalGrant,g.value);
    f.write('usage.source.register',{sourceId:next.id});f.bind({id:'renewed-binding',sourceId:next.id,attemptId:'resume'});appendUsage(g.path,2,150,15);
    worker=createUsageWorker(f.store,()=>f.actor,60000);for(let i=0;i<6;i++)worker.tick();
    assert.equal(createUsageReport(f.store,'alpha',{targetVersion:'0.9.0'}).counts.total.recorded,165);
    assert.equal([...usageObjects(f.store,'alpha','usage-observation')].filter(r=>r.sourceId==='source-one').length,1);
  }finally{Date.now=originalNow;worker?.close();f.cleanup();}
});

test('instance and stage narrowing restrict the report source inventory as well as counts',()=>{
  const f=fixture();try{
    for(let i=0;i<101;i++){
      const id='source-'+String(i).padStart(3,'0'),s={...source(),id,threadId:'thread-'+i};f.save('usage-source',id,s);
      const instance=pinInstance('instance-'+i,f.instance.pins.definitionRevisionId,f.instance.definition,{...f.authority,instanceId:'instance-'+i});f.save('lifecycle-instance',instance.id,instance);
      f.bind({id:'binding-'+i,sourceId:id,instanceId:instance.id,stageId:i?'verification':'implementation',baseStage:i?'verification':'implementation'});
      retainObservations(f.store,f.actor,s,[obs(1,counts(10,1))],{cursor:1},()=>f.actor);
    }
    assert.throws(()=>createUsageReport(f.store,'alpha',{targetVersion:'0.9.0'}),{code:'USAGE_REPORT_SCOPE'});
    for(const narrow of [{instanceId:'instance-0'},{stageId:'implementation'}]){
      const report=createUsageReport(f.store,'alpha',{targetVersion:'0.9.0',...narrow});assert.equal(report.counts.total.recorded,11);assert.equal(report.sources.length,1);assert.equal(report.sources[0].id,'source-000');
    }
  }finally{f.cleanup();}
});
