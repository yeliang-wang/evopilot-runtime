import {registerFixedScenario} from './preflight.mjs';
import {pathToFileURL as collectorPathToFileURL} from 'node:url';
import {resolve as collectorResolve} from 'node:path';
// Final-candidate qualification only. All positive inputs are original actual
// campaigns; corrupted private copies are used only for explicit negative probes.
// No business execution, synthetic positive report, release or source build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {parse as parseYaml} from 'yaml';
import {openScenario,repository as collectorRepository,sha} from './support.mjs';

const repository=fs.realpathSync(collectorRepository);
const repo='yeliang-wang/evopilot-runtime';
const entries=['expert','http-mcp','http-api','cli','graph','yaml'];
const documentFiles=['README.md','README_CN.md','docs/runtime-v090.md','docs/zh-CN/runtime-v090.md','docs/acceptance-v090.md','plugins/codex/skills/evopilot-runtime-expert/SKILL.md','plugins/codex/skills/evopilot-runtime-expert/references/configuration.md','plugins/codex/mcp.template.json','lifecycle/base/manifest.json','lifecycle/base/software-release-0.9.0.json','src/server/cli.ts','src/server/mcp.ts'];
const documentChecks=['BILINGUAL_README','TECHNICAL_GUIDES','BASE_CONTRACT','EXPERT_HTTP_PLUGIN','CLI_COMMANDS','CAPABILITIES_AND_CONFIGURATION','NO_RUNTIME_LLM_OR_AUTONOMOUS_AGENT','POST_RELEASE_REMAINS_SEPARATE'];
const exact=(v,names)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...names].sort());};
const hash=v=>assert(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v));
function bounded(ref,max,privateFile=true){
 assert(path.isAbsolute(ref)&&path.resolve(ref)===ref&&fs.realpathSync(ref)===ref);
 const fd=fs.openSync(ref,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const before=fs.fstatSync(fd);assert(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=max);if(privateFile)assert(before.uid===process.getuid()&&(before.mode&0o077)===0);const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);assert.equal(bytes.length,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.ctimeMs,before.ctimeMs);return bytes;}finally{fs.closeSync(fd);}
}
function pinned(pin,max){exact(pin,['ref','sha256']);hash(pin.sha256);const bytes=bounded(pin.ref,max);assert.equal(sha(bytes),pin.sha256);return bytes;}
const parsed=(pin,max)=>JSON.parse(pinned(pin,max));
function retain(run,name,bytes){
 const chunks=Math.ceil(bytes.length/1048576),digest=sha(bytes);
 for(let i=0;i<chunks;i++)run.artifact(name+'-bytes.json',{encoding:'base64',index:i,chunks,totalBytes:bytes.length,sha256:digest,bytes:bytes.subarray(i*1048576,(i+1)*1048576).toString('base64')});
 return{sha256:digest,bytes:bytes.length,chunks};
}
function fixture(run){
 assert(run.selection.releaseQualification,'E20 requires its protected exact qualification input; absent CI or campaigns cannot be replaced by source tests');
 const f=parsed(run.selection.releaseQualification,1048576);
 exact(f,['schema','candidateInput','prerequisiteReports','usageReport','releaseNotes','documentationReview','extensionEvidence','githubCli']);
 assert.equal(f.schema,'runtime-v090-release-qualification-fixture/v1');
 assert.equal(f.candidateInput.repository,repo);assert.equal(f.candidateInput.files['distribution-manifest.json'].sha256,run.candidate.manifestDigest);assert.equal(f.candidateInput.files['evopilot-runtime-0.9.0-darwin-arm64.tar.gz'].sha256,run.candidate.archiveDigest);
 assert.equal(run.selection.qualification,'FINAL_CANDIDATE','Development observations cannot qualify E20');
 assert.equal(f.prerequisiteReports.length,19);assert.deepEqual(f.prerequisiteReports.map(x=>x.scenario).sort(),Array.from({length:19},(_,i)=>'E'+String(i+1).padStart(2,'0')));
 exact(f.githubCli,['executable','sha256']);hash(f.githubCli.sha256);assert.equal(path.basename(f.githubCli.executable),'gh');assert.equal(sha(bounded(f.githubCli.executable,134217728,false)),f.githubCli.sha256);
 assert((fs.statSync(f.githubCli.executable).mode&0o111)!==0);assert.equal(fs.statSync(f.githubCli.executable).mode&0o022,0);
 return f;
}
function evidenceInput(f){const c=f.candidateInput;return{schema:'runtime-e20-prerequisite-evidence-input/v1',sourceCommit:c.sourceCommit,manifest:c.files['distribution-manifest.json'],archive:c.files['evopilot-runtime-0.9.0-darwin-arm64.tar.gz'],sourceRevision:c.files['source-revision.txt'],reports:f.prerequisiteReports};}
function originalCases(f){
 const records=new Map();for(const entry of f.prerequisiteReports){const report=parsed(entry.report,33554432),root=path.dirname(entry.report.ref);for(const result of report.results){assert(!records.has(result.caseInstanceId));records.set(result.caseInstanceId,{result,root,candidate:report.candidate});}}return records;
}
function raw(records,id,leaf){
 const item=records.get(id);assert(item,'A referenced case must belong to the audited E01–E19 inventory');assert(/^[A-Za-z0-9_.-]+$/.test(leaf));
 const matches=item.result.evidence.filter(x=>x.artifact===leaf||x.request===leaf||x.response===leaf);assert.equal(matches.length,1,'Use one original case-owned raw observation');
 const evidence=matches[0],digest=evidence.request===leaf?evidence.requestDigest:evidence.fileDigest,bytes=bounded(path.join(item.root,leaf),16777216);assert.equal(sha(bytes),digest);
 return{bytes,value:JSON.parse(bytes),digest,evidence,candidate:item.candidate};
}
async function github(run,f,signal){
 const runRecord=parsed(f.candidateInput.sourceCi.run,8388608),jobRecord=parsed(f.candidateInput.sourceCi.jobs,8388608),artifact=parsed(f.candidateInput.sourceCi.artifact,8388608);
 for(const id of [runRecord.id,runRecord.run_attempt,jobRecord.jobs?.[0]?.id,artifact.id])assert(Number.isSafeInteger(id)&&id>0);
 async function get(endpoint,limit,label){
  signal.throwIfAborted();assert(endpoint==='/user'||endpoint.startsWith('/repos/'+repo+'/actions/'));
  const args=['api','--hostname','github.com','--method','GET',endpoint];
  const result=await new Promise(resolve=>execFile(f.githubCli.executable,args,{encoding:'buffer',maxBuffer:limit,timeout:120000,signal},(error,stdout,stderr)=>resolve({code:error?.code??0,signal:error?.signal??null,stdout,stderr})));
  run.artifact('github-read-request.json',{executable:f.githubCli.executable,executableSha256:f.githubCli.sha256,args,exitCode:result.code,signal:result.signal,stderrBytes:result.stderr?.length??0,stderrDigest:sha(result.stderr??Buffer.alloc(0)),mutation:false});
  assert.equal(result.code,0,'Original authenticated GitHub read failed; no fallback or inferred CI success');assert.equal(result.signal,null);assert(result.stdout.length>0&&result.stdout.length<=limit);
  retain(run,label,result.stdout);return result.stdout;
 }
 const user=JSON.parse(await get('/user',1048576,'github-identity'));assert(Number.isSafeInteger(user.id)&&user.id>0);assert.equal(user.type,'User');assert.equal(typeof user.login,'string');
 const prefix='/repos/'+repo+'/actions',runId=runRecord.id,attempt=runRecord.run_attempt;
 const currentRun=JSON.parse(await get(`${prefix}/runs/${runId}/attempts/${attempt}`,8388608,'github-run'));
 const jobs=JSON.parse(await get(`${prefix}/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,8388608,'github-jobs'));
 const currentArtifact=JSON.parse(await get(`${prefix}/artifacts/${artifact.id}`,8388608,'github-artifact'));
 const jobLog=await get(`${prefix}/jobs/${jobRecord.jobs[0].id}/logs`,16777216,'github-log');
 const artifactZip=await get(`${prefix}/artifacts/${artifact.id}/zip`,268435456,'github-zip');
 assert.equal(sha(jobLog),f.candidateInput.sourceCi.jobLog.sha256);assert.equal(sha(artifactZip),f.candidateInput.sourceCi.artifactZip.sha256);
 return{input:{sourceCommit:f.candidateInput.sourceCommit,manifestDigest:run.candidate.manifestDigest,archiveDigest:run.candidate.archiveDigest,artifactDigest:sha(artifactZip),run:currentRun,jobs,artifact:currentArtifact,jobLog:jobLog.toString('utf8'),artifactZip},identity:{id:user.id,login:user.login},runId,attempt};
}
function checkDocuments(run,f,records){
 const review=parsed(f.documentationReview,1048576);exact(review,['schema','sourceCommit','candidateDigest','files','checks']);assert.equal(review.schema,'runtime-v090-documentation-observation/v1');assert.equal(review.sourceCommit,f.candidateInput.sourceCommit);assert.equal(review.candidateDigest,run.candidateDigest);
 assert.deepEqual(review.files.map(x=>x.path).sort(),[...documentFiles].sort());
 const sources=new Map();for(const file of review.files){exact(file,['path','sha256']);hash(file.sha256);const bytes=bounded(path.join(repository,file.path),1048576,false);assert.equal(sha(bytes),file.sha256);assert.deepEqual(bounded(path.join(run.selection.installedRoot,'package',file.path),1048576,false),bytes,'Reviewed docs/contracts must be the installed candidate bytes');sources.set(file.path,bytes.toString('utf8'));}
 const locations={BILINGUAL_README:['README.md','README_CN.md'],TECHNICAL_GUIDES:['docs/runtime-v090.md','docs/zh-CN/runtime-v090.md'],BASE_CONTRACT:['lifecycle/base/manifest.json','lifecycle/base/software-release-0.9.0.json'],EXPERT_HTTP_PLUGIN:['plugins/codex/skills/evopilot-runtime-expert/SKILL.md','plugins/codex/mcp.template.json'],CLI_COMMANDS:['src/server/cli.ts'],CAPABILITIES_AND_CONFIGURATION:['src/server/mcp.ts','plugins/codex/skills/evopilot-runtime-expert/references/configuration.md'],NO_RUNTIME_LLM_OR_AUTONOMOUS_AGENT:['README.md','README_CN.md','plugins/codex/skills/evopilot-runtime-expert/SKILL.md'],POST_RELEASE_REMAINS_SEPARATE:['docs/acceptance-v090.md']};
 // Check the concrete published claims as well as retaining the review's exact
 // source excerpts. These checks never turn a prose hash into domain approval.
 assert(sources.get('README.md').includes('Runtime requires no LLM Profile and runs no autonomous model loop.'));
 assert(sources.get('README_CN.md').includes('Runtime 不需要 LLM Profile，也不运行自主模型循环。'));
 assert.match(sources.get('plugins/codex/skills/evopilot-runtime-expert/SKILL.md'),/Do not configure a Runtime LLM profile/);
 assert.deepEqual(review.checks.map(x=>x.id).sort(),[...documentChecks].sort());
 for(const check of review.checks){
  exact(check,['id','observation','locations','evidence']);assert(typeof check.observation==='string'&&check.observation.length>20&&check.observation.length<=4096);assert(check.locations.length>0&&check.locations.length<=16);assert(check.evidence.length>0&&check.evidence.length<=16);
  assert(locations[check.id].every(file=>check.locations.some(x=>x.path===file)),'Every fixed documentation surface requires its own concrete excerpt');
  for(const location of check.locations){exact(location,['path','startLine','endLine','excerptSha256']);assert(sources.has(location.path));const lines=sources.get(location.path).split('\n');assert(Number.isSafeInteger(location.startLine)&&Number.isSafeInteger(location.endLine)&&location.startLine>0&&location.endLine>=location.startLine&&location.endLine<=lines.length&&location.endLine-location.startLine<200);assert.equal(sha(lines.slice(location.startLine-1,location.endLine).join('\n')),location.excerptSha256);}
  for(const observation of check.evidence){exact(observation,['caseInstanceId','files']);assert(observation.files.length>0&&observation.files.length<=16);for(const leaf of observation.files)raw(records,observation.caseInstanceId,leaf);}
 }
 const notes=pinned(f.releaseNotes,262144).toString('utf8');assert(notes.trim());assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes));
 run.artifact('documentation-original-observations.json',{review,reference:f.documentationReview,releaseNotes:f.releaseNotes,semanticReview:'Concrete source excerpts and original behavior evidence require reviewer assessment; hashes are not semantic approval'});
 return{documentFiles:review.files,checks:review.checks.map(c=>c.id),releaseNotesDigest:f.releaseNotes.sha256};
}
function extensionProbe(records,entry,selected){
 const expectedCase=['graph','yaml'].includes(entry)?'E04.EX12':'E03.EX12';assert.equal(selected.caseInstanceId,expectedCase);
 let request,body,identity;
 if(['http-api','http-mcp','cli'].includes(entry)){
  exact(selected,['caseInstanceId','request','response']);const a=raw(records,expectedCase,selected.request),b=raw(records,expectedCase,selected.response);assert.equal(a.evidence,b.evidence,'The exact original request and response must form one retained exchange');
  if(entry==='http-api'){request=a.value.envelope;assert.equal(b.value.status,200);body=JSON.parse(b.value.rawBody);}
  if(entry==='http-mcp'){assert.equal(a.value.path,'/mcp');assert.equal(a.value.method,'POST');const q=JSON.parse(a.value.rawBody),r=JSON.parse(b.value.rawBody);assert.equal(q.method,'tools/call');assert.equal(q.params.name,'runtime_read');assert.equal(r.id,q.id);assert.equal(b.value.status,200);assert(!r.error&&!r.result.isError);request=q.params.arguments;body=JSON.parse(r.result.content[0].text);}
  if(entry==='cli'){request=a.value;assert.equal(b.value.exitCode,0);assert.equal(b.value.signal,null);assert.equal(path.basename(b.value.executable),'node');assert(b.value.args[0].endsWith('/package/dist/server/cli.js'));assert.equal(b.value.args[1],'request');assert.equal(b.value.args.at(-2),'--request-ref');assert.equal(b.value.args.at(-1),path.join(records.get(expectedCase).root,selected.request));body=JSON.parse(b.value.stdout);}
  identity=expectedCase+':'+selected.request;
 }else if(entry==='expert'){
  exact(selected,['caseInstanceId','artifact','itemId']);const {value:v}=raw(records,expectedCase,selected.artifact);assert.equal(v.actualModelTurn,true);assert(typeof v.threadId==='string'&&typeof v.turnId==='string');assert(Array.isArray(v.frames));
  assert(v.frames.some(x=>x.method==='turn/completed'&&x.params?.threadId===v.threadId&&x.params?.turn?.id===v.turnId&&x.params.turn.status==='completed'));
  const matches=v.frames.filter(x=>x.method==='item/completed'&&x.params?.threadId===v.threadId&&x.params?.turnId===v.turnId&&x.params?.item?.id===selected.itemId);assert.equal(matches.length,1);const call=matches[0].params.item;assert.equal(call.type,'mcpToolCall');assert.equal(call.server,'evopilot_runtime');assert.equal(call.tool,'runtime_read');assert.equal(call.status,'completed');assert(!call.result.isError);request=call.arguments;body=JSON.parse(call.result.content[0].text);identity=expectedCase+':'+selected.artifact+':'+selected.itemId;
 }else{
  exact(selected,['caseInstanceId','artifact','networkIndex','actionIndex']);const {value:v}=raw(records,expectedCase,selected.artifact);assert(typeof v.browserVersion==='string');assert.deepEqual(v.errors,[]);assert.deepEqual(v.external,[]);assert.deepEqual(v.pending,[]);assert(Number.isSafeInteger(selected.networkIndex)&&selected.networkIndex>=0&&Number.isSafeInteger(selected.actionIndex)&&selected.actionIndex>=0);
  const action=v.actions[selected.actionIndex],row=v.network[selected.networkIndex];assert.equal(action.status,'COMPLETED');assert.match(action.action,entry==='graph'?/SeeCode|graph|图形/:/YAML|源码/);assert.equal(row.path,'/api/v1/dashboard/request');assert.equal(row.method,'POST');assert.equal(row.status,200);assert.equal(row.transportOutcome,'RESPONSE_RETAINED');request=row.request;body=JSON.parse(row.rawBody);
  // A label plus "some response after this action" can misattribute a later
  // YAML edit to an earlier graph edit. Require the original producer's exact
  // action interval, response identity and finite network capture boundaries.
  // The qualification fixture cannot supply or backfill this observation.
  const link=action.validationEvidence;
  assert(link,'MISSING_ORIGINAL_UI_CAUSAL_EVIDENCE: the actual E04.EX12 producer must retain the action-to-validation link');
  exact(link,['entry','operation','projectId','yamlSha256','requestId','networkRange']);exact(link.networkRange,['start','end']);
  assert.equal(link.entry,entry);assert.equal(link.operation,'lifecycle.definition.validate');assert.equal(link.projectId,request.projectId);assert.equal(link.yamlSha256,sha(request.input.yaml));assert.equal(link.requestId,body.requestId);assert(/^[-a-f0-9]{36}$/.test(link.requestId));
  const {start,end}=link.networkRange;assert(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<end&&end<=v.network.length);assert(selected.networkIndex>=start&&selected.networkIndex<end);
  const started=Date.parse(action.startedAt),finished=Date.parse(action.finishedAt),observed=Date.parse(row.at);assert(Number.isFinite(started)&&Number.isFinite(finished)&&started<=observed&&observed<=finished,'The exact UI validation response must complete within its recorded action');
  const correlated=v.network.slice(start,end).filter(n=>n.transportOutcome==='RESPONSE_RETAINED'&&typeof n.rawBody==='string'&&JSON.parse(n.rawBody).requestId===link.requestId);assert.equal(correlated.length,1);assert.equal(correlated[0],row);identity=expectedCase+':'+selected.artifact+':'+selected.networkIndex;
 }
 assert.equal(request.operation,'lifecycle.definition.validate');exact(request.input,['yaml']);assert(typeof request.input.yaml==='string');assert.equal(request.projectId,records.get(expectedCase).candidate.projectId);assert(typeof body.requestId==='string');assert(!body.error&&body.result?.compilation);return{request,result:body.result,identity};
}
function checkExtensions(run,f,records,matrix){
 const proof=parsed(f.extensionEvidence,1048576);exact(proof,['schema','sourceCommit','candidateDigest','legalYaml','illegalYaml','entries']);assert.equal(proof.schema,'runtime-v090-extension-entry-evidence/v1');assert.equal(proof.sourceCommit,f.candidateInput.sourceCommit);assert.equal(proof.candidateDigest,run.candidateDigest);
 const legal=pinned(proof.legalYaml,262144).toString('utf8'),illegal=pinned(proof.illegalYaml,262144).toString('utf8');assert.notEqual(legal,illegal);
 const legalValue=parseYaml(legal),illegalValue=parseYaml(illegal);assert(legalValue&&typeof legalValue==='object'&&!Array.isArray(legalValue));assert(illegalValue&&typeof illegalValue==='object'&&!Array.isArray(illegalValue));assert(Array.isArray(legalValue.extensions)&&legalValue.extensions.length>0,'A Base-only YAML is not extension acceptance');assert(Object.hasOwn(illegalValue,'extensions'));
 const {extensions:legalExtensions,...legalOther}=legalValue,{extensions:illegalExtensions,...illegalOther}=illegalValue;assert.notDeepEqual(illegalExtensions,legalExtensions,'The negative input must change the extension itself');assert.deepEqual(illegalOther,legalOther,'An unrelated missing credential or configuration field cannot stand in for an illegal extension');
 assert.deepEqual(proof.entries.map(e=>e.entry).sort(),[...entries].sort());const used=new Set(),observed=[];let diagnostic;
 for(const item of proof.entries){exact(item,['entry','valid','invalid']);const good=extensionProbe(records,item.entry,item.valid),bad=extensionProbe(records,item.entry,item.invalid);for(const p of [good,bad]){assert(!used.has(p.identity),'One observation cannot stand in for another entry or input');used.add(p.identity);}assert.equal(good.request.input.yaml,legal);assert.equal(bad.request.input.yaml,illegal);assert.equal(good.result.compilation.valid,true);assert.equal(good.result.ready,true);assert.equal(bad.result.ready,false);assert.equal(bad.result.validationDigest,null);assert.equal(bad.result.compilation.valid,false,'Use an actual compiler-refused illegal extension, not an unavailable environment');
  const extensionIssues=bad.result.compilation.issues.filter(i=>/^EXTENSION_[A-Z_]+$/.test(i.code)&&/^extensions(?:$|\[|\.)/.test(i.path));assert(extensionIssues.length>0,'Require the native extension diagnostic');assert(extensionIssues.every(i=>bad.result.issues.some(x=>x.code===i.code&&x.path===i.path&&x.rule===i.rule)));
  const issues=bad.result.issues.map(i=>({code:i.code,path:i.path,rule:i.rule}));if(diagnostic)assert.deepEqual(issues,diagnostic,'Entries must return the same server-side refusal');else diagnostic=issues;observed.push({entry:item.entry,valid:good.identity,invalid:bad.identity,issues});}
 const ids=matrix.caseInstances.filter(c=>/\.EX\d+$/.test(c.caseInstanceId)&&c.scenario!=='E20').map(c=>c.caseInstanceId);assert.equal(ids.length,20);assert.equal(new Set(ids.map(id=>id.split('.').at(-1))).size,12);for(const id of ids)assert.equal(records.get(id)?.result.status,'PASS');
 run.artifact('extension-original-entry-inventory.json',{reference:f.extensionEvidence,legalYaml:proof.legalYaml,illegalYaml:proof.illegalYaml,entries:observed,requiredExternalExtensionInstances:ids,allTwelveContractsRequired:true});return{entries:observed,externalExtensionInstances:ids,ownE20ExtensionCaseNotPrecredited:true};
}
function negativeInventory(run,f,audit,caseInstanceId){
 assert(['E20.journey','E20.CV07'].includes(caseInstanceId));
 const original=evidenceInput(f),first=original.reports[0],source=parsed(first.report,33554432),sourceRoot=path.dirname(first.report.ref),outcomes=[];let serial=0;
 const rejected=(name,input,pattern)=>{let message;try{audit(repository,input);}catch(error){message=error.message;}assert(typeof message==='string'&&pattern.test(message),'The selected guard must reject this exact negative, not a missing E20 or unrelated file');outcomes.push({name,error:message,expectedGuard:String(pattern),faultInjected:true});};
 rejected('empty-inventory',{...original,reports:[]},/Exactly E01–E19 prerequisite reports/);
 rejected('missing-scenario',{...original,reports:original.reports.slice(1)},/Exactly E01–E19 prerequisite reports/);
 rejected('duplicate-scenario',{...original,reports:[...original.reports.slice(0,18),original.reports[0]]},/Exactly E01–E19 prerequisite reports/);
 rejected('foreign-scenario',{...original,reports:[...original.reports.slice(0,18),{...original.reports[18],scenario:'E21'}]},/Exactly E01–E19 prerequisite reports/);
 const changes=[['empty-collected-set',r=>r.selected=0,/Partial, failed, skipped or stale report/],['missing-variant',r=>r.results.pop(),/Result set is missing, duplicated or foreign/],['duplicate-variant',r=>r.results[0]=r.results[1],/Result set is missing, duplicated or foreign/],['skip',r=>r.results[0].status='SKIP',/Nonpassing or unasserted case/],['xfail',r=>r.results[0].status='XFAIL',/Nonpassing or unasserted case/],['wrong-candidate',r=>r.candidateDigest='sha256:'+'0'.repeat(64),/Report is not for this final candidate/],['development-result',r=>r.qualification='DEVELOPMENT',/Report is not for this final candidate/]];
 for(const [name,change,pattern]of changes){
  const root=path.join(run.selection.outputRoot,caseInstanceId+'-negative-'+String(++serial).padStart(2,'0'));fs.mkdirSync(root,{mode:0o700});const report=structuredClone(source);change(report);const bytes=Buffer.from(JSON.stringify(report)+'\n'),ref=path.join(root,'REPORT.json');fs.writeFileSync(ref,bytes,{mode:0o600,flag:'wx'});fs.writeFileSync(path.join(root,'selection.json'),bounded(path.join(sourceRoot,'selection.json'),1048576),{mode:0o600,flag:'wx'});
  rejected(name,{...original,reports:[{scenario:first.scenario,report:{ref,sha256:sha(bytes)}},...original.reports.slice(1)]},pattern);
  run.artifact('negative-qualification-input.json',{name,originalReport:first.report,mutatedReport:{ref,sha256:sha(bytes)},mutationOnlyInPrivateFaultCopy:true,positiveQualificationAllowed:false});
 }
 const after=audit(repository,original);assert.equal(after.passed,652);run.artifact('native-negative-inventory-results.json',{outcomes,originalReportsUnchanged:true,originalPositiveAudit:after});return outcomes;
}

export async function executeE20(t) {
 const run=await openScenario('E20',undefined,t);let f;
 try{
  assert.equal(run.all.length,3);f=fixture(run);
  const load=file=>import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist/release',file)).href),native=await load('evidence.js'),candidateApi=await load('gate.js'),usageApi=await load('usage-evidence.js'),ciApi=await load('source-ci.js');
  assert.equal(typeof native.inspectE20PrerequisiteEvidence,'function','The exact installed candidate must contain the fixed prerequisite audit');
  const matrix=JSON.parse(fs.readFileSync(path.join(repository,'governance/parameter-matrix-v090.json'))),catalog=JSON.parse(fs.readFileSync(path.join(repository,'governance/acceptance-v090.json')));
  let shared;
  const prerequisites=async()=>{
   if(shared)return shared;
   const candidate=await candidateApi.inspectRuntimeReleaseCandidate(repository,f.candidateInput,t.signal);assert.equal(candidate.candidateDigest,run.candidateDigest);assert.equal(candidate.archiveDigest,run.candidate.archiveDigest);assert.equal(candidate.releaseAuthorized,false);
   const original=native.inspectE20PrerequisiteEvidence(repository,evidenceInput(f));assert.equal(original.passed,652);assert.equal(original.remainingE20,3);assert.equal(original.fullReleaseAuditRequired,true);
   const c=f.candidateInput,usage=usageApi.inspectUsageAcceptanceEvidence(repository,{schema:'runtime-usage-evidence-input/v1',sourceCommit:c.sourceCommit,manifest:c.files['distribution-manifest.json'],archive:c.files['evopilot-runtime-0.9.0-darwin-arm64.tar.gz'],sourceRevision:c.files['source-revision.txt'],report:f.usageReport});assert.equal(usage.passed,23);assert.equal(usage.releaseAuthorized,false);
   const actual=await github(run,f,t.signal),ci=await ciApi.inspectSourceCiRecords(actual.input,t.signal);assert.deepEqual(ci.files,candidate.sourceCi.files);assert.deepEqual(ci.counts,candidate.sourceCi.counts);assert.equal(ci.runId,candidate.sourceCi.runId);assert.equal(ci.attempt,candidate.sourceCi.attempt);assert.equal(ci.jobId,candidate.sourceCi.jobId);assert.equal(ci.artifactId,candidate.sourceCi.artifactId);
   const records=originalCases(f);assert.equal(records.size,652);shared={candidate,original,usage,records,actualCi:{runId:ci.runId,attempt:ci.attempt,jobId:ci.jobId,artifactId:ci.artifactId,authenticatedPrincipal:actual.identity}};run.artifact('original-qualification-prerequisites.json',{candidate,original,usage,actualCi:shared.actualCi,originalReports:f.prerequisiteReports,usageReport:f.usageReport,noE20Placeholder:true});return shared;
  };
  for(const c of run.cases)await run.collect(c,async()=>{
   t.signal.throwIfAborted();const state=await prerequisites();run.artifact('case-qualification-binding.json',{caseInstanceId:c.caseInstanceId,candidateDigest:run.candidateDigest,sourceCommit:f.candidateInput.sourceCommit,originalReportPins:state.original.reportPins,usageReportDigest:state.usage.reportDigest,actualCi:state.actualCi});
   if(c.caseInstanceId==='E20.EX12')return checkExtensions(run,f,state.records,matrix);
   if(c.caseInstanceId==='E20.CV07'){
    const negatives=negativeInventory(run,f,native.inspectE20PrerequisiteEvidence,c.caseInstanceId),required=matrix.caseInstances.filter(x=>x.phase==='PRE_RELEASE'&&x.scenario!=='E20').map(x=>x.caseInstanceId);assert.deepEqual([...state.records.keys()].sort(),required.sort());
    const platforms={github:required.filter(id=>id.startsWith('E01.')),gitlab:required.filter(id=>id.startsWith('E02.'))};assert(platforms.github.length>1&&platforms.gitlab.length>1);assert(required.some(id=>id.startsWith('E18.stage.gitlab.')));assert(required.some(id=>id.startsWith('E18.stage.github.')));
    run.artifact('fixed-pre-release-case-inventory.json',{requiredCaseIds:required,platforms,remainingE20:['E20.journey','E20.EX12','E20.CV07'],postReleaseCaseIds:matrix.caseInstances.filter(x=>x.phase==='POST_RELEASE').map(x=>x.caseInstanceId),negativeGuards:negatives});return{frozenOriginalDenominator:664,prerequisiteCases:652,remainingE20:3,postRelease:9,additiveUsageSeparatelyRequired:23,allProviderCaseIdsRequired:true,negativeGuards:negatives,fullReleaseAuditStillRequired:true};
   }
   assert.equal(c.caseInstanceId,'E20.journey');const documents=checkDocuments(run,f,state.records),extensions=checkExtensions(run,f,state.records,matrix),negatives=negativeInventory(run,f,native.inspectE20PrerequisiteEvidence,c.caseInstanceId);
   const groups=[...new Set(catalog.scenarios.filter(s=>s.phase==='PRE_RELEASE').flatMap(s=>s.groups))].sort();assert.equal(groups.length,62);assert(!groups.includes('P03')&&!groups.includes('P04'));
   const traceability=groups.map(id=>({id,caseInstanceIds:matrix.caseInstances.filter(row=>row.phase==='PRE_RELEASE'&&catalog.scenarios.find(s=>s.id===row.scenario).groups.includes(id)).map(x=>x.caseInstanceId)}));assert(traceability.every(row=>row.caseInstanceIds.length));
   const status=await run.read('runtime.status');assert.equal(status.independentLlm,false);
   assert.throws(()=>native.inspectAcceptanceEvidence(repository,evidenceInput(f)),/Wrong source input/);assert.throws(()=>native.inspectAcceptanceEvidence(repository,{...evidenceInput(f),schema:'runtime-release-evidence-input/v1'}),/Exactly E01–E20 reports are required/);
   run.artifact('release-qualification-review-material.json',{sourceCommit:f.candidateInput.sourceCommit,candidate:state.candidate,traceability,documents,extensions,negativeGuards:negatives,originalPrerequisiteCount:652,additiveUsageCount:23,remainingOwnCases:['E20.journey','E20.EX12','E20.CV07'],postReleaseIndependent:['E21','E22','UT24'],full655AuditRunsOnlyAfterThisCollectorCompletes:true,productAcceptance:'NOT_EVALUATED',releaseAuthorized:false});
   return{sourceAndCiExact:true,sixAssetsMatchIndependentCi:true,preReleaseRequirementGroups:62,prerequisiteCases:652,additiveUsageCases:23,documentationChecks:documents.checks,extensionInstances:extensions.externalExtensionInstances,negativeGuards:negatives.length,sourceTestsNotSubstituteForE2E:true,full655AuditStillRequired:true,productAcceptance:'NOT_EVALUATED',releaseAuthorized:false};
  });
  if(shared){native.inspectE20PrerequisiteEvidence(repository,evidenceInput(f));await candidateApi.inspectRuntimeReleaseCandidate(repository,f.candidateInput,t.signal);for(const pin of [f.documentationReview,f.extensionEvidence,f.releaseNotes])pinned(pin,1048576);}
 }finally{run.finish();}
}
if(process.argv[1]&&collectorPathToFileURL(collectorResolve(process.argv[1])).href===import.meta.url)test('E20 exact source, original CI assets and frozen prerequisite qualification',{timeout:900000},executeE20);

// Fixed source-audited branches; no fixture or provider action runs at registration.
const E20_CALLABLE_ROUTES=Object.freeze({"E20.journey":{"handler":"prerequisites/checkDocuments/checkExtensions/negativeInventory"},"E20.EX12":{"handler":"prerequisites/checkExtensions"},"E20.CV07":{"handler":"prerequisites/negativeInventory/fixed-inventory"}});
export function registerE20CallableCases(catalog){
 const prerequisites=catalog.filter(c=>c.phase==='PRE_RELEASE'&&(c.scenario!=='E20'&&/^E\d\d$/.test(c.scenario??'')||c.scenario==='UT')).map(c=>c.caseInstanceId??c.id);assert.equal(prerequisites.length,675);
 const routes=Object.fromEntries(Object.entries(E20_CALLABLE_ROUTES).map(([id,row])=>[id,{...row,evidenceDependsOn:prerequisites}]));
 return registerFixedScenario({scenario:'E20',phase:'PRE_RELEASE',catalog,routes,execute:executeE20});
}
