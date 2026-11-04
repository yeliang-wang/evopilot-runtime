import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium,expect} from '@playwright/test';
import {openScenario,sha} from './support.mjs';

const stages=['scope','plan','implementation','candidate','verification','release-decision','publication','closure'];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function pinned(ref,digest,max=262144){
 assert.equal(fs.realpathSync(ref),ref);const st=fs.lstatSync(ref);
 assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0&&st.size<=max);
 const bytes=fs.readFileSync(ref);assert.equal(sha(bytes),digest);return bytes;
}
test('E02 actual installed GitLab lifecycle with external Codex and native owners',async()=>{
 const run=await openScenario('E02');let expert,browser,context,traceStarted=false;const pending=new Set(),network=[],browserErrors=[];
 const cfg=run.selection.lifecycleExecution;assert(cfg);const root=cfg.exchangeRoot;
 assert.equal(fs.realpathSync(root),root);assert.equal(fs.readdirSync(root).length,0,'Never reuse an external Agent exchange');assert.equal(fs.lstatSync(root).mode&0o777,0o700);
 assert(Number.isInteger(cfg.timeoutSeconds)&&cfg.timeoutSeconds>=300&&cfg.timeoutSeconds<=3600);
 const preparation=JSON.parse(pinned(cfg.preparationRef,cfg.preparationSha256)),fixture=JSON.parse(pinned(cfg.ownerFixtureRef,cfg.ownerFixtureSha256));
 assert.equal(preparation.source.provider,'gitlab');assert.equal(fixture.syntheticAssets,true);assert.equal(fixture.syntheticDecisions,true);assert.equal(fixture.workspaceId,run.selection.workspaceId);assert.equal(fixture.scope.projectId,run.selection.projectId);
 const scope={visibility:'private',projectId:run.selection.projectId};let serial=0;
 const save=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
 const syntheticDecision=subject=>{
  // Explicit test attestation, never an actual user's domain/release approval.
  const value={synthetic:true,message:'Isolated synthetic test attestation, not human or business authority',subject},source=JSON.stringify(value),sourcePath=path.join(root,'decision-'+(++serial)+'-source.json');fs.writeFileSync(sourcePath,source,{mode:0o600,flag:'wx'});
  const body=JSON.stringify({schema:'evopilot-decision-evidence/v1',subject,source:{reference:pathToFileURL(sourcePath).href+'#sha256='+sha(source),description:'Synthetic test fixture decision only'}}),ref=path.join(root,'decision-'+serial+'.json');fs.writeFileSync(ref,body,{mode:0o600,flag:'wx'});
  run.artifact('synthetic-decision.json',{subject,source:JSON.parse(source),evidence:JSON.parse(body),sourceDigest:sha(source),evidenceDigest:sha(body)});return pathToFileURL(ref).href+'#sha256='+sha(body);
 };
 const mutate=async(operation,input,label)=>{
  const status=await run.read('runtime.status'),r=await run.request(operation,input,{requestId:run.requestId('E02.journey',label),expectedRevision:status.revision});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body.result;
 };
 const until=async(operation,input,predicate,label,seconds=300)=>{
  const end=Date.now()+seconds*1000;let last;
  do{last=await run.read(operation,input);if(predicate(last))return last;
   assert(!['FAILED','UNKNOWN'].includes(last.progress?.phase),'Inspect original '+label+' outcome; no redispatch');await pause(1000);
  }while(Date.now()<end);throw Error('Original '+label+' inspection deadline exceeded: '+JSON.stringify(last));
 };
 const stage=async(instanceId,stageId)=>{
  const allowed=await run.read('lifecycle.stage.admission',{instanceId,stageId});run.artifact('stage-admission.json',{stageId,actual:allowed});
  const r=await mutate('lifecycle.stage.request',{instanceId,stageId},'stage-'+stageId);return r.result.stageRequestId;
 };
 const complete=id=>until('lifecycle.stage.request.inspect',{stageRequestId:id},r=>r.progress.phase==='COMPLETE','stage completion');
 const advance=(id,label)=>mutate('lifecycle.stage.advance',{stageRequestId:id},label);
 const installed=await import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist/installation/installer.js')).href),installPlan=JSON.parse(fs.readFileSync(path.join(run.selection.installedRoot,'installation-plan.json')));
 const service=async command=>{const r=await installed.runInstaller(installPlan,command);run.artifact('installed-service-control.json',{command,result:r});return r;};
 try{
  for(const c of run.cases)await run.collect(c,async()=>{
   assert.equal(c.caseInstanceId,'E02.journey','Remaining fixed candidate-drift/admission/budget/feedback variants require their own evidence; never credit them from happy-path assertions');
   const input=run.selection.expertConfiguration,yaml=pinned(input.ref,input.sha256).toString();assert(yaml.endsWith('\n')&&!yaml.endsWith('\n\n'));
   const before=await run.read('lifecycle.definition.inspect');assert.equal(before.active,null,'Fresh installed project required');
   const preview=await run.read('lifecycle.definition.validate',{yaml});assert.equal(preview.ready,true,JSON.stringify(preview.issues));assert.equal(preview.compilation.effective.semantic.config.implementation.provider,'gitlab');
   expert=await run.openExpert();
   const wizard=await expert.configurationTurn('Configure this isolated project with GitLab. Read lifecycle.base.inspect and lifecycle.definition.inspect. Ask for the necessary configuration for ALL eight Base stages, naming each exact stage ID and required GitLab fields in a single reply. GitHub-specific fields must not be required. Do not write or start execution. I will provide the complete approved test configuration next.');
   const text=wizard.messages.join('\n');for(const id of stages)assert(text.includes(id));assert(wizard.calls.some(c=>c.arguments.operation==='lifecycle.base.inspect'));assert(wizard.calls.some(c=>c.arguments.operation==='lifecycle.definition.inspect'));
   const write={operation:'lifecycle.definition.save-and-activate',projectId:run.selection.projectId,input:{yaml,validationDigest:preview.validationDigest},requestId:run.requestId(c.caseInstanceId,'activate'),expectedRevision:before.revision};
   const activated=await expert.configurationTurn('This is the already-approved synthetic test configuration. Validate the exact YAML through Runtime; only if ready is true, activate it once with lifecycle.definition.save-and-activate using requestId '+write.requestId+' and expectedRevision '+before.revision+'. Preserve one final LF. Then read back the active revision. Do not separately save, request routine confirmation, create decisions or start any stage.\n\n```yaml\n'+yaml+'```',write);
   assert(activated.calls.some(c=>c.arguments.operation==='lifecycle.definition.validate'));await expert.close();expert=null;
   const active=await run.read('lifecycle.definition.inspect');assert(active.active);assert.equal(await run.source(active.active.id),yaml);
   assert.deepEqual((await run.configurationEntry('cli','lifecycle.definition.inspect')).result,active);
   const prepared=await mutate('lifecycle.preparation.save',{...preparation,definitionRevisionId:active.active.id},'prepare');assert.equal(prepared.result.executionAuthorized,false);
   const instanceId=run.selection.runId,subject={instanceId,definitionRevisionId:active.active.id,goalRef:preparation.goalRef,targetRef:prepared.result.preparationRef,loopRef:preparation.loopRef,budget:preview.compilation.effective.semantic.config.plan.budget,expiresAt:new Date(Date.now()+cfg.timeoutSeconds*1000).toISOString()};
   const auth=await run.read('lifecycle.authority.preview',{kind:'execution',subject}),evidenceRef=syntheticDecision({owner:'runtime',operation:'lifecycle.authority.execution',workspaceId:run.selection.workspaceId,scope,reviewDigest:auth.reviewDigest,decision:'APPROVE'});
   const decision=await mutate('lifecycle.authority.record',{kind:'execution',subject,reviewDigest:auth.reviewDigest,decision:'APPROVE',evidenceRef},'execution-decision');
   await mutate('lifecycle.instance.create',{instanceId,definitionRevisionId:active.active.id,authorityRef:decision.result.authorityRef},'instance');

   browser=await chromium.launch();context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});const page=await context.newPage();
   page.on('pageerror',e=>browserErrors.push(e.message));page.on('response',response=>{
    const u=new URL(response.url());if(u.origin!==run.serviceOrigin||!['/api/v1/dashboard/monitor','/api/v1/dashboard/request'].includes(u.pathname))return;
    const task=(async()=>{const body=await response.text();assert(Buffer.byteLength(body)<=262144);network.push({path:u.pathname,status:response.status(),request:response.request().method()==='POST'?response.request().postDataJSON():null,rawBody:body});})();pending.add(task);task.then(()=>pending.delete(task),e=>{browserErrors.push(e.message);pending.delete(task);});
   });
   await page.goto(run.serviceOrigin+'/lifecycle');await page.getByLabel('一次性连接码').fill(await run.browserCode());await page.getByRole('button',{name:'连接项目',exact:true}).click();await expect(page.getByLabel('Project Lifecycle YAML')).toHaveValue(yaml);await expect(page.getByText('图形已与当前源码结构核对',{exact:false})).toBeVisible();run.imageArtifact(await page.screenshot({fullPage:true}));
   await context.tracing.start({screenshots:true,snapshots:true,sources:false});traceStarted=true;
   await page.goto(run.serviceOrigin+'/monitor');await expect(page.getByRole('heading',{name:'生命周期监控',exact:true})).toBeVisible();await expect(page.getByLabel('生命周期实例',{exact:true})).toHaveValue(instanceId);assert.equal(await page.getByLabel('Project Lifecycle YAML').count(),0);
   const ids={};
   for(const name of ['scope','plan']){ids[name]=await stage(instanceId,name);await complete(ids[name]);const proof=await run.read('lifecycle.'+name+'.evidence.read',{stageRequestId:ids[name]});run.artifact(name+'-original-evidence.json',proof);}
   ids.implementation=await stage(instanceId,'implementation');await until('lifecycle.stage.request.inspect',{stageRequestId:ids.implementation},r=>r.progress.phase==='WAITING_AGENT','actual Codex handoff');
   const handoff=await run.read('lifecycle.agent.handoff.read',{stageRequestId:ids.implementation});assert.equal(handoff.handoff.runtimeStartsAgent,false);
   save('HANDOFF.json',handoff);save('CALL-CONTEXT.json',{connectionRef:run.selection.connectionRef,projectId:run.selection.projectId,stageRequestId:ids.implementation,handoffDigest:handoff.handoff.digest,deadlineAt:handoff.handoff.deadlineAt,host:handoff.handoff.agent,capabilities:handoff.handoff.capabilities});
   process.stdout.write(JSON.stringify({waitingForActualCurrentCodex:true,exchangeRoot:root,stageRequestId:ids.implementation})+'\n');
   const reported=await until('lifecycle.agent.report.read',{stageRequestId:ids.implementation},r=>r.report?.state==='SUBMITTED','external current Codex',Math.min(1200,cfg.timeoutSeconds));
   assert(reported.report.result.change.kind==='merge-request');const commit=reported.report.result.commit;
   const sourceReview=await run.read('lifecycle.implementation.review.preview',{stageRequestId:ids.implementation}),sourceEvidence=syntheticDecision({owner:'runtime',operation:'lifecycle.implementation.review',workspaceId:run.selection.workspaceId,scope,reviewDigest:sourceReview.reviewDigest,decision:'APPROVE'});
   await mutate('lifecycle.implementation.review.record',{stageRequestId:ids.implementation,reviewDigest:sourceReview.reviewDigest,decision:'APPROVE',evidenceRef:sourceEvidence},'source-review');
   await advance(ids.implementation,'implementation-ci');await until('lifecycle.implementation.evidence.read',{stageRequestId:ids.implementation},r=>r.ci?.artifact?.status==='PASSED','implementation original CI');
   await advance(ids.implementation,'implementation-native');await complete(ids.implementation);
   const impl=await run.read('lifecycle.implementation.evidence.read',{stageRequestId:ids.implementation});assert.equal(impl.derivation.request.plan.parameters.commit,commit);assert.equal(impl.ci.owners.harness.receipt.result.qualityStatus,'PASS');
   for(const name of ['candidate','verification']){
    ids[name]=await stage(instanceId,name);await until('lifecycle.stage.request.inspect',{stageRequestId:ids[name]},r=>r.progress.phase==='RUNNING',name+' original CI');await advance(ids[name],name+'-native');const final=await complete(ids[name]);assert.equal(final.request.plan.parameters.commit,commit);
    if(name==='verification')assert(final.request.plan.parameters.candidateInput.archive.jobId);
   }
   const verified=await run.read('lifecycle.instance.inspect',{instanceId}),feedback=await run.read('lifecycle.verification.feedback.read',{stageRequestId:ids.verification});
   ids['release-decision']=await stage(instanceId,'release-decision');await until('lifecycle.stage.request.inspect',{stageRequestId:ids['release-decision']},r=>r.progress.phase==='RUNNING','release material');
   const material=await run.read('lifecycle.release.evidence.read',{stageRequestId:ids['release-decision']});assert.equal(material.material.documents.documents.length,4);
   const releaseSubject={instanceId,candidateDigest:verified.instance.candidateDigest,expiresAt:subject.expiresAt},releaseReview=await run.read('lifecycle.authority.preview',{kind:'release',subject:releaseSubject});assert.deepEqual(releaseReview.releaseMaterial,material.material);
   const releaseEvidence=syntheticDecision({owner:'runtime',operation:'lifecycle.authority.release',workspaceId:run.selection.workspaceId,scope,reviewDigest:releaseReview.reviewDigest,decision:'APPROVE'});
   await mutate('lifecycle.authority.record',{kind:'release',subject:releaseSubject,reviewDigest:releaseReview.reviewDigest,decision:'APPROVE',evidenceRef:releaseEvidence},'test-release-decision');await advance(ids['release-decision'],'release-decision-finish');await complete(ids['release-decision']);
   ids.publication=await stage(instanceId,'publication');await until('lifecycle.publication.evidence.read',{stageRequestId:ids.publication},r=>r.evidence?.artifact?.status==='PASSED','test publication original artifact');await advance(ids.publication,'publication-native');await complete(ids.publication);
   ids.closure=await stage(instanceId,'closure');await until('lifecycle.closure.evidence.read',{stageRequestId:ids.closure},r=>r.evidence?.smoke?.status==='PASSED','original distribution smoke');await advance(ids.closure,'closure-native');
   // Advance acknowledges scheduling. Observe its original asynchronous owner
   // action and feedback delivery; never infer completion from that receipt or
   // issue another advance while it is running.
   const pendingFeedback=await until('lifecycle.closure.evidence.read',{stageRequestId:ids.closure},r=>r.evidence.harness.status==='PASS'&&['ontology','harness'].every(owner=>r.evidence.feedback[owner].status==='REVIEW_REQUIRED'),'original closure native action and feedback');assert.equal(pendingFeedback.archiveAction,null);
   await service('stop');
   for(const owner of ['ontology','harness']){
    const api=await import(pathToFileURL(path.join(fixture.packageRoots[owner],'dist/service.js')).href);
    const material=async({reference,scope:requestedScope})=>{const a=await import(pathToFileURL(path.join(fixture.packageRoots[reference.product],'dist/service.js')).href),svc=a[reference.product==='ontology'?'createOntologyService':'createHarnessService']({workspaceRoot:fixture.workspaceRoot,workspaceId:fixture.workspaceId});svc.initialize();try{const r=await svc.native({operation:'native.package.readback',scope:requestedScope,input:{id:reference.id,version:reference.version}});return{reference:r.reference,scope:requestedScope,workspaceId:fixture.workspaceId,published:true,package:r.package};}finally{svc.close();}};
    const native=api[owner==='ontology'?'createOntologyService':'createHarnessService']({workspaceRoot:fixture.workspaceRoot,workspaceId:fixture.workspaceId},{readFeedback:async()=>feedback.event,resolveFeedbackMaterial:material});native.initialize();
    try{
     const write=async(operation,input,label)=>{const request={operation,scope,input,requestId:run.requestId(c.caseInstanceId,label),expectedRevision:(await native.feedback({operation:'feedback.inspect',scope,input:{}})).revision},response=await native.feedback(request);run.artifact('owner-feedback-original.json',{owner,request,response});return response;};
     const review=await write('feedback.propose',{id:feedback.event.id,proposal:{mode:'REUSE',reference:fixture.references[owner],rationale:'Synthetic fixture disposition only; actual Runtime/GitLab evidence, no business domain decision',changes:[]}},owner+'-review');
     const humanEvidenceRef=syntheticDecision({owner,operation:'feedback.decide',workspaceId:fixture.workspaceId,scope,reviewDigest:review.result.reviewDigest,decision:'APPROVE'});
     await write('feedback.decide',{id:feedback.event.id,reviewDigest:review.result.reviewDigest,decision:'APPROVE',humanEvidenceRef},owner+'-decide');
    }finally{native.close();}
   }
   await service('start');await advance(ids.closure,'closure-archive');await complete(ids.closure);
   const closure=await run.read('lifecycle.closure.evidence.read',{stageRequestId:ids.closure}),final=await run.read('lifecycle.instance.inspect',{instanceId});assert.equal(closure.evidence.archive.status,'COMPLETE');for(const owner of ['ontology','harness'])assert.equal(closure.evidence.feedback[owner].status,'REUSE_APPROVED');for(const name of stages)assert.equal(final.instance.stages[name].status,'PASSED');
   // Browser sessions expire on restart; reconnect through a new one-use code.
   await page.goto(run.serviceOrigin+'/monitor');if(await page.getByLabel('一次性连接码').count()){await page.getByLabel('一次性连接码').fill(await run.browserCode());await page.getByRole('button',{name:'连接项目',exact:true}).click();}
   await expect(page.getByLabel('生命周期实例',{exact:true})).toHaveValue(instanceId);await expect(page.locator('tbody tr')).toHaveCount(8);await expect(page.locator('tbody tr td:nth-child(2)')).toHaveText(Array(8).fill('已通过'));run.imageArtifact(await page.screenshot({fullPage:true}));
   await Promise.all([...pending]);assert(!network.some(n=>n.request?.requestId),'Monitor/readback must not perform business writes');assert.deepEqual(browserErrors,[]);
   run.artifact('browser-original-network.json',{network,browserVersion:browser.version(),serviceId:run.candidate.serviceId,instanceId});
   const trace=path.join(root,'browser-trace.zip');await context.tracing.stop({path:trace});traceStarted=false;fs.chmodSync(trace,0o600);run.traceArtifact(fs.readFileSync(trace));
   await context.close();context=null;await browser.close();browser=null;
   await service('stop');await service('start');assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId})).instance,final.instance);assert.deepEqual(await run.read('lifecycle.closure.evidence.read',{stageRequestId:ids.closure}),closure);
   run.artifact('gitlab-journey-summary.json',{stageRequests:ids,commit,change:reported.report.result.change,actualExpert:{wizard,activated},actualExternalCodex:true,actualGitLab:true,syntheticAssets:true,syntheticDecisions:true,realProductReleased:false,dailyInstallationChanged:false});
   return{stageRequests:ids,allEightPassed:true,commit,mergeRequest:reported.report.result.change,independentLlm:false,actualExpert:true,actualBrowser:true,actualNativeOwners:true,exactCandidate:verified.instance.candidateDigest,archiveSealed:true,originalFeedbackReviewed:true,restartPreservesClosure:true,remainingVariantsNotCredited:true};
  });
 }finally{
  if(traceStarted&&context){const trace=path.join(root,'failed-browser-trace.zip');await context.tracing.stop({path:trace});fs.chmodSync(trace,0o600);run.traceArtifact(fs.readFileSync(trace));}
  await Promise.allSettled([...pending]);await context?.close();await browser?.close();await expert?.close();run.finish();
 }
});
