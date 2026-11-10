import {pathToFileURL as collectorPathToFileURL} from 'node:url';
import {resolve as collectorResolve} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {openScenario,sha} from './support.mjs';

const stages=['scope','plan','implementation','candidate','verification','release-decision','publication','closure'];
export async function executeE10() {
 const run=await openScenario('E10');let expert,browser,context,completed=null;
 try{
  const input=run.selection.expertConfiguration;assert.deepEqual(Object.keys(input).sort(),['ref','sha256']);
  assert.equal(fs.realpathSync(input.ref),input.ref);const st=fs.lstatSync(input.ref);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=262144&&(st.mode&0o077)===0&&st.uid===process.getuid());
  const bytes=fs.readFileSync(input.ref);assert.equal(sha(bytes),input.sha256);const yaml=bytes.toString();assert(yaml.endsWith('\n')&&!yaml.endsWith('\n\n'));
  run.artifact('expert-input.json',{input,syntheticConfiguration:true,yaml,scope:'Definition configuration only; no execution, semantic asset decision or publication'});
  for(const c of run.cases)await run.collect(c,async()=>{
   if(['E10.variant.01','E10.MC01'].includes(c.caseInstanceId)){
    assert(completed,'MC01 aliases require the actual full same-campaign dialogue, never a label or a prior candidate');
    const ref=path.join(run.selection.outputRoot,'E10.journey.json'),original=fs.readFileSync(ref);assert.equal(JSON.parse(original).status,'PASS');
    run.artifact('mc01-dialogue-binding.json',{primaryCase:'E10.journey',primaryCaseDigest:sha(original),actualConversation:completed.turns,stages:completed.stages,interpretation:'The frozen matrix includes both the named MC01 variant and its expanded alias; both bind the exact same actual eight-stage dialogue, not independent extra runs'});
    return{actualEightStageConversation:true,sameEntryActivation:true,stageIds:stages,sourceCase:'E10.journey',sourceCaseDigest:sha(original),noDashboardRequiredForExpert:true};
   }
   assert.equal(c.caseInstanceId,'E10.journey','CV05 requires a separate actual active-CI/authority-drift journey; it cannot be credited by configuration reconnection');
   const before=await run.read('lifecycle.definition.inspect');assert.equal(before.active,null,'Use a fresh isolated project; never reset historical state to prepare a run');
   const statusBefore=await run.read('runtime.status');assert.equal(statusBefore.independentLlm,false);
   const preview=await run.read('lifecycle.definition.validate',{yaml});assert.equal(preview.ready,true,JSON.stringify(preview.issues));
   assert.deepEqual(preview.compilation.effective.nodes.filter(n=>n.source==='base').map(n=>n.id),stages);
   expert=await run.openExpert();
   const wizard=await expert.configurationTurn('I want to configure this project lifecycle using GitLab. First read the publisher Base and current definition from Runtime. Guide me through ALL eight base stages in one reply, using their exact stage IDs as headings and the actual required field paths. Ask for the missing inputs in that reply. I will provide the complete approved isolated test configuration next. Do not write, activate or dispatch anything yet; do not ask me to open Dashboard. The Runtime tools are already selected.');
   const wizardText=wizard.messages.join('\n');for(const stage of stages)assert(wizardText.includes(stage),'Wizard omitted stage '+stage);
   assert(wizard.calls.some(c=>c.arguments.operation==='lifecycle.base.inspect'));assert(wizard.calls.some(c=>c.arguments.operation==='lifecycle.definition.inspect'));
   assert.deepEqual(await run.read('lifecycle.definition.inspect'),before);
   const requestId=run.requestId(c.caseInstanceId,'activate'),write={operation:'lifecycle.definition.save-and-activate',projectId:run.selection.projectId,input:{yaml,validationDigest:preview.validationDigest},requestId,expectedRevision:before.revision};
   const configured=await expert.configurationTurn('Here are the complete answers for all eight stages and both published owner asset references in the YAML below. This exact synthetic configuration is already approved for definition activation. Validate it through Runtime, then use lifecycle.definition.save-and-activate once ONLY if ready is true, and read back the active definition. Use requestId '+requestId+' and the current project revision '+before.revision+'. Do not create a separate draft save, alter the YAML, repeat confirmation, open Dashboard or create any execution/decision. Preserve exactly one final LF after the last YAML line. Report the active definition revision and any real service problem.\n\n```yaml\n'+yaml+'```',write);
   assert(configured.calls.some(c=>c.tool==='runtime_read'&&c.arguments.operation==='lifecycle.definition.validate'&&c.arguments.input.yaml===yaml));
   assert(configured.calls.some(c=>c.tool==='runtime_read'&&c.arguments.operation==='lifecycle.definition.inspect'));
   const after=await run.read('lifecycle.definition.inspect');assert(after.active);assert.equal(after.revision,before.revision+1);assert.equal(await run.source(after.active.id),yaml);
   const cli=(await run.configurationEntry('cli','lifecycle.definition.inspect')).result;assert.deepEqual(cli,after);
   browser=await chromium.launch();context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});const page=await context.newPage(),network=[],pending=new Set(),errors=[];
   const listener=response=>{const u=new URL(response.url());if(u.origin!==run.serviceOrigin||u.pathname!=='/api/v1/dashboard/request')return;const task=(async()=>{const body=await response.text();assert(Buffer.byteLength(body)<=262144);network.push({path:u.pathname,status:response.status(),request:response.request().postDataJSON(),rawBody:body});})();pending.add(task);task.then(()=>pending.delete(task),e=>{errors.push(e.message);pending.delete(task);});};
   page.on('response',listener);page.on('pageerror',e=>errors.push(e.message));
   try{
    await page.goto(run.serviceOrigin+'/lifecycle');await page.getByLabel('一次性连接码').fill(await run.browserCode());await page.getByRole('button',{name:'连接项目',exact:true}).click();await expect(page.getByRole('heading',{name:'生命周期定义',exact:true})).toBeVisible();
    await expect(page.getByLabel('Project Lifecycle YAML')).toHaveValue(yaml);
    await expect(page.getByText('图形已与当前源码结构核对',{exact:false})).toBeVisible();
    const session=await context.request.get(run.serviceOrigin+'/api/v1/dashboard/session');assert.equal(session.status(),200);const identity=(await session.json()).result;assert.equal(identity.serviceId,run.candidate.serviceId);assert.equal(identity.workspaceId,run.selection.workspaceId);assert.equal(identity.projectId,run.selection.projectId);
    await Promise.all([...pending]);assert.deepEqual(errors,[]);assert(!network.some(n=>n.request.requestId),'Readback must not submit another definition or execution');
    run.imageArtifact(await page.screenshot({fullPage:true}));
    run.artifact('expert-browser-readback.json',{browserVersion:browser.version(),network,errors,serviceId:identity.serviceId,projectId:identity.projectId,sourceDigest:sha(yaml),active:after.active,authentication:'Actual one-use connection code; secret values and headers omitted'});
   }finally{page.off('response',listener);await Promise.allSettled([...pending]);await context.close();context=null;await browser.close();browser=null;}
   await expert.close();expert=null;assert.deepEqual(await run.read('lifecycle.definition.inspect'),after);
   expert=await run.openExpert();const refreshed=await expert.configurationTurn('This is a new connection to the existing project. Read runtime.status and lifecycle.definition.inspect from the server and report the exact service ID, active definition revision and current project revision. Use current server state, do not repeat configuration confirmation, do not save or activate anything, and do not create/cancel/replay any Run. No Dashboard is needed.');
   assert(refreshed.calls.some(c=>c.arguments.operation==='runtime.status'));assert(refreshed.calls.some(c=>c.arguments.operation==='lifecycle.definition.inspect'));assert(refreshed.messages.join('\n').includes(after.active.id));
   const statusAfter=await run.read('runtime.status');assert.equal(statusAfter.serviceId,statusBefore.serviceId);assert.deepEqual(await run.read('lifecycle.definition.inspect'),after);
   await expert.close();expert=null;
   completed={stages,turns:[wizard,configured,refreshed].map(t=>({threadId:t.threadId,turnId:t.turnId,model:t.model,provider:t.provider,productCalls:t.calls.length,approvalResponses:t.approvalResponses})),active:after.active,projectRevision:after.revision};
   run.artifact('expert-journey-summary.json',{...completed,serviceId:run.candidate.serviceId,independentLlm:false,actualInstalledHttpMcp:true,actualCli:true,actualBrowser:true,refreshedHost:true,activeCiExitRecovery:'Separate CV05 obligation remains unexecuted',executionRequested:false});
   return{...completed,sameDefinitionAcrossExpertCliBrowser:true,serviceSurvivesHostExit:true,refreshedHostReadsCurrentState:true,noSeparateSkillInstallation:true,noRuntimeLlmAccount:true,noBusinessRunOrRelease:true};
  });
 }finally{await context?.close();await browser?.close();await expert?.close();run.finish();}
}
if(process.argv[1]&&collectorPathToFileURL(collectorResolve(process.argv[1])).href===import.meta.url)test('E10 actual installed Expert configuration and same-service readback',executeE10);
