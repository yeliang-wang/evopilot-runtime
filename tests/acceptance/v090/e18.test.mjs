import {registerFixedScenario} from './preflight.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {openScenario,sha} from './support.mjs';
import {collectCoverageInventory,collectManagedBudget} from './execution.mjs';

// This file consumes original records from the selected installed service. It
// never seeds a database, changes an instance outcome, dispatches CI, approves a
// release, fabricates provider responses, or treats a source test as installed
// acceptance. Write requests are limited to two explicitly denied instance
// entry probes and optional reconciliation of an already dispatched publication
// request, explicitly selected by allowReconciliation. Denied entry probes must
// leave both the instance and project revision unchanged.
//
// ciAuthority pins a private runtime-v090-ci-authority-fixture/v1 document:
// {schema,candidateDigest,workspaceId,projectId,syntheticAssets:true,
//  syntheticDecisions:true,casePlans:{[fixedCaseId]:plan}}.
// Stage plan: {instanceId,predecessorId}; predecessorId is null only for scope.
// publication.failed selects {instanceId,predecessorId:'release-decision',
// authorityRef,decisionRequestId}: exact current native REJECT; reports the true
// RUNNING/UNKNOWN stage and denied admission, never claims terminal FAILED.
// Scope negative plans preserve the fixed outcome IDs but inspect actual entry
// prerequisites, as required by accepted CV03 (not a fictitious graph node):
// not-run: {scopePrerequisite:'authority-not-recorded',subject,authorityRef};
// failed: {scopePrerequisite:'authority-rejected',instanceId,
//          definitionRevisionId,authorityRef};
// unknown: {scopePrerequisite:'binding-observation-unknown',instanceId,authorityRef};
// missing-evidence: {scopePrerequisite:'required-preparation-document-missing',
//                   instanceId,authorityRef,documentRole}.
// Fault conditions and any explicitly synthetic REJECT are prepared outside
// this collector through native APIs / isolated owned inputs. It creates no
// decision and does not damage a dependency to manufacture the precondition.
// Provider plan: {provider,passing:{stageRequestId,runId},
//  oldCandidate:{stageRequestId,runId},rerun:{stageRequestId,runId},
//  skipped:{stageRequestId,runId},
//  release:{instanceId,authorityRef},
//  publication:{stageRequestId,unknownObservationRef,allowReconciliation:true}}.
// E18.journey selects {providers:[<github plan>,<gitlab plan>]}. No free-form
// operations, remote commands, authority evidence or supplied PASS are accepted.
// forkCredential additionally selects an original native CI in a registered
// isolated fork, its exact job and an original upstream PRESENT probe. It never dispatches a fork pipeline or copies a protected secret.
// CV03 uses the shared exact native budget collector independently.
const stages=['scope','plan','implementation','candidate','verification','release-decision','publication','closure'];
const outcomes=['not-run','failed','unknown','missing-evidence','passed'];
const hash=/^sha256:[a-f0-9]{64}$/;
const read=ref=>JSON.parse(fs.readFileSync(ref));
const missingEvidenceReasons=['CI_RESULT_MISSING','CI_CANDIDATE_MISSING','OWNER_OBSERVATION_MISSING'];
function keys(value,required){
 assert(value&&typeof value==='object'&&!Array.isArray(value));
 assert.deepEqual(Object.keys(value).sort(),[...required].sort(),'Fixture contains missing or unsupported fields');
}
function pinned(pin){
 keys(pin,['ref','sha256']);assert.equal(fs.realpathSync(pin.ref),pin.ref);
 const st=fs.lstatSync(pin.ref);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0&&st.size<=1048576);
 const bytes=fs.readFileSync(pin.ref);assert.equal(sha(bytes),pin.sha256);return JSON.parse(bytes);
}
function differentDigest(value){assert(hash.test(value));return 'sha256:'+(value[7]==='0'?'1':'0')+value.slice(8);}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export const FORK_PROBE_JOB='runtime-fork-credential-probe';
const forkProbeFiles=['fork-credential-probe.json','fork-credential-probe.stderr','fork-credential-probe.stdout'];
export function validateForkCredentialSelection(p){
 assert(p,'E18_FORK_CREDENTIAL_NOT_READY: original upstream/fork CI probe bindings required');keys(p,['stageRequestId','runId','jobId','credentialName','upstream']);keys(p.upstream,['stageRequestId','runId','jobId']);for(const v of [p,p.upstream]){assert(typeof v.stageRequestId==='string'&&v.stageRequestId);for(const id of [v.runId,v.jobId])assert(/^[1-9][0-9]{0,19}$/.test(id));}assert(/^[A-Z][A-Z0-9_]{2,63}$/.test(p.credentialName));assert(!/^(GITHUB_|GITLAB_|CI_|RUNTIME_|ACTIONS_|NODE_)/.test(p.credentialName),'Select a dedicated protected business credential, not an automatic runner token');return p;
}
export function assertForkLineage(provider,upstream,fork,upstreamId,forkId){
 assert.notEqual(upstreamId,forkId);assert.equal(String(upstream.id),upstreamId);assert.equal(String(fork.id),forkId);if(provider==='github'){assert.equal(fork.fork,true);assert.equal(String(fork.parent?.id),upstreamId);}else{assert.equal(provider,'gitlab');assert.equal(String(fork.forked_from_project?.id),upstreamId,'NOT_READY: provider must retain the actual fork parent');}return{provider,upstreamId,forkId};
}
export function forkCredentialProbeScript(name){
 assert(/^[A-Z][A-Z0-9_]{2,63}$/.test(name));return `node --input-type=module >fork-credential-probe.stdout 2>fork-credential-probe.stderr <<'RUNTIME_FORK_CREDENTIAL_PROBE'\nimport fs from 'node:fs';\nconst e=process.env,absent=!e[${JSON.stringify(name)}],report={schema:'runtime-fork-credential-probe/v1',provider:e.PROBE_PROVIDER,repositoryId:e.PROBE_REPOSITORY_ID,runId:e.PROBE_RUN_ID,jobKey:'runtime-fork-credential-probe',requestId:e.runtime_request_id,inputDigest:e.runtime_input_digest,sourceCommit:e.runtime_source_commit,workflowDigest:e.runtime_workflow_digest,credentialName:${JSON.stringify(name)},credentialState:absent?'ABSENT':'PRESENT',exitCode:absent?78:0};\nconst text=JSON.stringify(report)+'\\n';fs.writeFileSync('fork-credential-probe.json',text,{flag:'wx'});process.stdout.write(text,()=>process.exit(report.exitCode));\nRUNTIME_FORK_CREDENTIAL_PROBE`;
}
export function assertForkProbeJob(provider,document,binding,name){
 // Validate the context that actually supplies the job environment, not only
 // the literal job body. A workflow-level NODE_OPTIONS preload can otherwise
 // forge both credential measurements while this fixed script stays unchanged.
 if(provider==='github'){assert(!Object.hasOwn(document,'env')&&!Object.hasOwn(document,'defaults'),'NOT_READY: the dedicated probe workflow must not inherit workflow env/defaults');}
 else{assert.equal(provider,'gitlab');assert(!Object.hasOwn(document,'include'),'NOT_READY: unverified merged GitLab includes cannot define the fixed probe');}
 const script=forkCredentialProbeScript(name),job=provider==='github'?document.jobs?.[FORK_PROBE_JOB]:document[FORK_PROBE_JOB];assert(job,'E18_FORK_CREDENTIAL_NOT_READY: exact fixed versioned probe job required');
 if(provider==='github'){
  keys(job,['name','runs-on','permissions','env','steps']);assert.equal(job.name,FORK_PROBE_JOB);assert.equal(job['runs-on'],binding.runner);assert.deepEqual(job.permissions,{});assert.deepEqual(job.env,{PROBE_PROVIDER:'github',PROBE_REPOSITORY_ID:'${{ github.repository_id }}',PROBE_RUN_ID:'${{ github.run_id }}',runtime_request_id:'${{ inputs.runtime_request_id }}',runtime_input_digest:'${{ inputs.runtime_input_digest }}',runtime_source_commit:'${{ inputs.runtime_source_commit }}',runtime_workflow_digest:'${{ inputs.runtime_workflow_digest }}',[name]:'${{ secrets.'+name+' }}'});assert.equal(job.steps.length,2);
  assert.deepEqual(job.steps[0],{name:'Measure protected credential',shell:'bash',run:script});const upload=job.steps[1];keys(upload,['name','if','uses','with']);assert.equal(upload.name,'Upload credential measurement');assert.equal(upload.if,'always()');assert(/^actions\/upload-artifact@[a-f0-9]{40}$/.test(upload.uses));assert.deepEqual(upload.with,{name:FORK_PROBE_JOB,path:forkProbeFiles.join('\n'),'if-no-files-found':'error'});
 }else{
  assert.equal(provider,'gitlab');keys(job,['stage','image','inherit','before_script','after_script','script','artifacts','allow_failure']);assert.equal(job.stage,'test');assert(/^node:24\.14\.0@sha256:[a-f0-9]{64}$/.test(job.image));assert.deepEqual(job.inherit,{default:false,variables:false});assert.deepEqual(job.before_script,[]);assert.deepEqual(job.after_script,[]);assert.deepEqual(job.script,[`PROBE_PROVIDER=gitlab PROBE_REPOSITORY_ID="$CI_PROJECT_ID" PROBE_RUN_ID="$CI_PIPELINE_ID" ${script}`]);assert.deepEqual(job.artifacts,{when:'always',paths:forkProbeFiles});assert.equal(job.allow_failure,false);
 }return job;
}
export function assertForkProbeJobObservation(provider,job,state){
 const absent=state==='ABSENT';assert(['ABSENT','PRESENT'].includes(state));assert.equal(job.name,FORK_PROBE_JOB);
 if(provider==='github'){
  assert.equal(job.run_attempt,1);assert.equal(job.conclusion,absent?'failure':'success');assert(Array.isArray(job.steps)&&job.steps.length>=4);let prior=0;for(const step of job.steps){assert(Number.isSafeInteger(step.number)&&step.number>prior);prior=step.number;assert.equal(step.status,'completed');}
  const names=['Set up job','Measure protected credential','Upload credential measurement','Complete job'],positions=names.map(name=>{const hits=job.steps.filter(s=>s.name===name);assert.equal(hits.length,1);return job.steps.indexOf(hits[0]);});assert(positions.every((n,i)=>i===0||n>positions[i-1]));assert.equal(positions[0],0);assert.equal(positions[3],job.steps.length-1);assert.equal(job.steps[positions[1]].conclusion,absent?'failure':'success');for(const i of [0,2,3])assert.equal(job.steps[positions[i]].conclusion,'success');
  const posts=job.steps.filter(s=>!names.includes(s.name));assert(posts.length<=1);for(const post of posts){assert.equal(post.name,'Post Upload credential measurement');assert.equal(post.conclusion,'success');assert(job.steps.indexOf(post)>positions[2]&&job.steps.indexOf(post)<positions[3]);}
 }else{assert.equal(provider,'gitlab');assert.equal(job.status,absent?'failed':'success');if(absent)assert.equal(job.failure_reason,'script_failure');assert.equal(job.allow_failure,false);}return job;
}
export function assertForkCredentialMeasurement(files,expected){
 assert.deepEqual([...files.keys()].sort(),forkProbeFiles);const bytes=files.get('fork-credential-probe.json');assert(bytes.length>0&&bytes.length<=8192);assert.deepEqual(files.get('fork-credential-probe.stdout'),bytes);assert.equal(files.get('fork-credential-probe.stderr').length,0);const report=JSON.parse(bytes);assert.deepEqual(report,{schema:'runtime-fork-credential-probe/v1',provider:expected.provider,repositoryId:expected.repositoryId,runId:expected.runId,jobKey:FORK_PROBE_JOB,requestId:expected.request.requestId,inputDigest:expected.request.inputDigest,sourceCommit:expected.request.commit,workflowDigest:expected.request.workflowDigest,credentialName:expected.credentialName,credentialState:expected.state,exitCode:expected.state==='ABSENT'?78:0});return report;
}
export function assertForkGitLabArtifact(metadata){
 // GitLab may retain latest-success/kept artifacts after the advertised expiry,
 // or indefinitely (null). Availability is proved by the bounded download and
 // stable original job metadata below, never by this timestamp alone.
 const file=metadata.artifacts_file;assert(file,'NOT_READY: original probe artifact metadata required');assert.equal(file.filename,'artifacts.zip');assert(Number.isSafeInteger(file.size)&&file.size>0&&file.size<=1048576,'NOT_READY: bounded dedicated probe archive required');return metadata;
}

// These readers classify exact original native facts. No input supplies an
// outcome, missing flag or latest-decision assertion. Unit callers use synthetic
// records; actual collection always obtains these values from the installed APIs.
export async function readE18Events(read){
 const events=[];let cursor;
 for(let pages=0;pages<1024;pages++){
  const page=await read('runtime.events.read',cursor===undefined?{}:{cursor});
  assert(Array.isArray(page.events)&&typeof page.cursor==='string');
  for(const e of page.events){assert(Number.isSafeInteger(e.seq)&&Number.isSafeInteger(e.revision));assert(!events.length||e.seq>events.at(-1).seq);events.push(e);assert(events.length<=32768,'NOT_READY: complete native event inventory exceeds bound');}
  if(!page.events.length)return events;
  assert.notEqual(page.cursor,cursor,'NOT_READY: native event pagination did not advance');cursor=page.cursor;
 }
 assert.fail('NOT_READY: complete native event inventory unavailable');
}
export function classifyE18MissingEvidence(retained,readback,history,digest,now=Date.now()){
 const {request:r,progress,instance}=retained,p=r.plan.parameters,o=progress.observation,prior=instance.stages[r.stageId];
 const {digest:rd,...rb}=r;assert.equal(rd,digest(rb));assert.equal(r.planDigest,digest(r.plan));assert.equal(r.plan.bindingDigest,digest(p));
 assert.equal(r.instanceId,instance.id);assert.equal(r.pinsDigest,instance.pinsDigest);assert.equal(r.id,prior.requestId);assert.equal(r.inputDigest,prior.inputDigest);
 assert(o);assert.equal(o.requestId,r.id);assert.equal(o.inputDigest,r.inputDigest);assert.equal(o.adapterDigest,r.plan.adapterDigest);assert.equal(prior.outcomeDigest,digest(o.outcome));
 assert.equal(o.phase,progress.phase);assert.equal(o.outcome.status,prior.status);assert.equal(progress.terminal,false);assert(Date.parse(r.deadlineAt)>now,'NOT_READY: original request expired');
 if(!['UNKNOWN','RUNNING'].includes(o.phase))return null;
 const missingChecks=()=>{const required=instance.definition.nodes.find(n=>n.id===r.stageId).checks,found=new Set(o.outcome.checks.map(c=>c.id));assert(required.some(id=>!found.has(id)));assert(!o.outcome.checks.some(c=>c.status==='FAIL'||c.status==='UNKNOWN'));};
 if(['implementation','candidate','verification'].includes(r.stageId)&&o.phase==='UNKNOWN'&&missingEvidenceReasons.includes(progress.reason)){missingChecks();return{kind:'ci-original-rejection',reason:progress.reason};}
 if(r.stageId==='scope'&&o.phase==='UNKNOWN'&&progress.reason===null){
  assert.equal(r.plan.adapterId,'runtime-scope-stage-v1');assert.equal(r.plan.action,'base.scope');assert.equal(o.handle?.preparationRef,p.preparationRef);
  if(readback?.status===404&&readback.body?.error?.code==='NOT_FOUND'){missingChecks();return{kind:'scope-original-evidence-absent',reason:'NOT_FOUND',operation:'lifecycle.scope.evidence.read'};}
  assert.equal(readback?.status,200,'NOT_READY: scope evidence read was uncertain');return null;
 }
 if(r.stageId==='plan'&&o.phase==='UNKNOWN'&&progress.reason===null){
  assert.equal(r.plan.adapterId,'runtime-plan-stage-v1');assert.equal(r.plan.action,'base.plan');assert.equal(o.handle?.preparationRef,p.preparationRef);
  if(readback?.status===404&&readback.body?.error?.code==='NOT_FOUND'){missingChecks();return{kind:'plan-original-input-absent',reason:'NOT_FOUND',operation:'lifecycle.plan.evidence.read'};}
  assert.equal(readback?.status,200,'NOT_READY: plan evidence read was uncertain');const value=readback.body.result,e=value.evidence,{digest:ed,...eb}=e;
  assert.equal(value.stageRequestId,r.id);assert.equal(value.historical,true);assert.equal(ed,digest(eb));assert.equal(e.requestDigest,r.digest);assert.equal(e.planDigest,r.planDigest);assert.equal(e.preparationDigest,p.preparationDigest);assert.equal(e.factsDigest,p.factsDigest);
  const absent=[];for(const kind of ['ontology','harness']){const {action:a,receipt}=value.owners[kind];if(!a)continue;const {digest:ad,...ab}=a;assert.equal(ad,digest(ab));assert.equal(a.requestDigest,digest({owner:kind,request:a.request}));assert.equal(a.request.operation,'native.package.validate');assert.equal(a.request.requestId,'plan-native-'+digest({requestId:r.id,projectId:r.projectId,owner:kind}).slice(7,55));assert.deepEqual(a.request.scope,p.owners[kind].scope);assert.equal(a.request.input.id,p.owners[kind].reference.id);assert.equal(a.request.input.version,p.owners[kind].reference.version);assert.equal(a.context.claimId,digest({stageRequestDigest:r.digest}));assert.equal(a.context.inputDigest,r.inputDigest);assert.deepEqual(a.request.input.context,a.context);if(receipt===null)absent.push({owner:kind,requestId:a.request.requestId,actionDigest:a.digest});}
  assert(absent.length<=1,'NOT_READY: multiple unretained owner receipts do not identify the native missing original');if(absent.length){missingChecks();return{kind:'plan-original-owner-receipt-absent',reason:'NOT_FOUND',absent};}return null;
 }
 if(r.stageId==='release-decision'){
  assert.equal(r.plan.adapterId,'runtime-release-admission-v1');assert.equal(r.plan.action,'base.release-decision');
  if(readback?.status===409&&readback.body?.error?.code==='RELEASE_MATERIAL_REQUIRED'){
   const interrupted=history.filter(v=>{const e=v.evidence;assert.equal(v.observationRef,digest(e));assert.equal(e.requestId,r.id);assert.equal(e.observation.requestId,r.id);assert.equal(e.observation.inputDigest,r.inputDigest);assert.equal(e.observation.adapterDigest,r.plan.adapterDigest);return e.observation.phase==='UNKNOWN'&&e.observation.outcome.status==='UNKNOWN'&&typeof e.reason==='string'&&e.reason.length>0;});
   assert(interrupted.length,'NOT_READY: retain original incomplete collection observation, not an unstarted or approval-waiting stage');missingChecks();return{kind:'release-original-material-absent',reason:'RELEASE_MATERIAL_REQUIRED',nativePhase:o.phase,interruptionRefs:interrupted.map(v=>v.observationRef)};
  }
  assert.equal(readback?.status,200,'NOT_READY: release material read was uncertain');return null;
 }
 if(r.stageId==='publication'&&o.phase==='UNKNOWN'){
  assert.equal(r.plan.adapterId,'runtime-publication-stage-v2');assert.equal(r.plan.action,'base.publication');assert.equal(readback?.status,200,'NOT_READY: publication evidence read was uncertain');const v=readback.body.result,e=v.evidence;if(!e)return null;
  assert.equal(v.evidenceRef,digest(e));assert.equal(e.requestDigest,r.digest);assert.equal(e.planDigest,r.planDigest);assert.equal(e.releaseAuthorityRef,r.releaseAuthorityRef);
  if(!e.reasons.includes('CI_RESULT_MISSING'))return null;
  assert.deepEqual(e.reasons,['CI_RESULT_MISSING'],'An unrelated publication failure cannot supply missing-evidence credit');assert(v.ciRequest&&v.run&&e.ci);assert.equal(e.schema,'runtime-publication-evidence/v1');assert.equal(e.ci.status,'PASSED');assert.equal(e.distribution?.status,'PASSED');assert.equal(e.artifact,null);assert.equal(e.harness,null);assert.equal(e.currentGrant,false);
  assert.equal(v.ciRequest.requestId,e.ci.requestId);assert.equal(v.ciRequest.inputDigest,r.inputDigest);assert.equal(v.ciRequest.commit,p.commit);assert.equal(v.ciRequest.stageId,'publication');assert.equal(v.ciRequest.workflowDigest,p.workflowDigest);assert.equal(v.ciRequest.bindingDigest,digest(p.binding));assert.equal(v.run.runId,e.ci.runId);assert.equal(e.ci.commit,p.commit);assert.equal(e.ci.repositoryId,p.binding.repositoryId);assert.equal(e.ci.provider,p.binding.provider);missingChecks();
  return{kind:'publication-original-result-absent',reason:'CI_RESULT_MISSING',evidenceRef:v.evidenceRef,runId:v.run.runId};
 }
 return null;
}
export function e18MissingEvidenceIdentity(value){
 if(value.readback===null)return value;
 // The native server assigns each observation a different HTTP correlation ID.
 // Retain the raw responses and compare every other field at the same path.
 const {requestId,...body}=value.readback.body;
 assert.equal(typeof requestId,'string');
 assert.match(requestId,/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
 return{...value,readback:{...value.readback,body}};
}

export function readE18DecisionOriginals(reference){
 const bytesOf=ref=>{const url=new URL(ref);assert.equal(url.protocol,'file:');assert.equal(url.host,'');assert.equal(url.search,'');assert(/^#sha256=[a-f0-9]{64}$/.test(url.hash));const expected=url.hash.slice(8);url.hash='';const filename=fileURLToPath(url);assert.equal(fs.realpathSync(filename),filename);const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;try{const st=fs.fstatSync(fd);assert(st.isFile()&&st.size>0&&st.size<=1048576);bytes=Buffer.alloc(st.size+1);let size=0;while(size<bytes.length){const n=fs.readSync(fd,bytes,size,bytes.length-size,null);if(!n)break;size+=n;}assert.equal(size,st.size);bytes=bytes.subarray(0,size);}finally{fs.closeSync(fd);}assert.equal(sha(bytes),expected);return{reference:ref,sha256:expected,bytes:bytes.length,base64:bytes.toString('base64')};};
 const decision=bytesOf(reference),value=JSON.parse(Buffer.from(decision.base64,'base64').toString('utf8'));assert.equal(value.schema,'evopilot-decision-evidence/v1');return{decision,source:bytesOf(value.source.reference)};
}
export function assertE18CurrentReleaseRejection(value,digest,now=Date.now()){
 const {instance:i,retained,authority:a,preview:v,receipt,events,principal,executionAuthority}=value,d=a.decision,{ref,...db}=d,r=retained.request,stage=i.stages['release-decision'];
 const {digest:requestDigest,...requestBody}=r;assert.equal(requestDigest,digest(requestBody));assert.equal(r.planDigest,digest(r.plan));assert.equal(r.plan.bindingDigest,digest(r.plan.parameters));
 assert.equal(executionAuthority.usable,true);assert.equal(executionAuthority.reason,null);assert.equal(executionAuthority.decision.ref,r.authorityRef);assert.equal(executionAuthority.decision.kind,'execution');assert.equal(executionAuthority.decision.choice,'APPROVE');assert.equal(executionAuthority.decision.subject.instanceId,i.id);assert.equal(executionAuthority.decision.subject.definitionRevisionId,i.pins.definitionRevisionId);
 assert.equal(ref,'authority:'+digest(db));assert.equal(d.schema,'runtime-authority-decision/v1');assert.equal(d.kind,'release');assert.equal(d.choice,'REJECT');assert.equal(a.revocation,null);assert.equal(a.usable,false);assert.equal(a.reason,'AUTHORITY_REVOKED');
 assert.equal(d.workspaceId,r.workspaceId);assert.equal(d.projectId,i.pins.projectId);assert.equal(d.principalId,principal.id);assert.equal(d.principalRevision,principal.revision);assert(Date.parse(d.subject.expiresAt)>now);assert(Date.parse(r.deadlineAt)>now);assert(Date.parse(principal.expiresAt)>now);
 assert.equal(r.stageId,'release-decision');assert.equal(r.plan.adapterId,'runtime-release-admission-v1');assert.equal(r.id,stage.requestId);assert.equal(r.instanceId,i.id);assert.equal(r.pinsDigest,i.pinsDigest);assert(['RUNNING','UNKNOWN'].includes(stage.status));assert.equal(retained.progress.terminal,false);assert.equal(retained.progress.phase,stage.status);assert.equal(retained.progress.observation.phase,stage.status);assert.equal(retained.progress.observation.requestId,r.id);assert.equal(retained.progress.observation.inputDigest,r.inputDigest);assert.equal(retained.progress.observation.adapterDigest,r.plan.adapterDigest);assert.equal(retained.progress.observation.outcome.requestId,r.id);assert.equal(retained.progress.observation.outcome.inputDigest,r.inputDigest);assert.equal(retained.progress.observation.outcome.status,stage.status);assert.equal(stage.outcomeDigest,digest(retained.progress.observation.outcome));
 assert.equal(i.stages.publication.status,'PENDING');assert.equal(i.stages.publication.attempts,0);assert.equal(i.stages.publication.requestId,null);
 assert.equal(v.authorityGranted,false);assert.equal(v.executionDispatched,false);const {reviewDigest,authorityGranted,executionDispatched,...review}=v;assert.equal(reviewDigest,digest(review));assert.equal(reviewDigest,d.reviewDigest);assert.equal(v.kind,'release');assert.equal(v.workspaceId,d.workspaceId);assert.equal(v.projectId,d.projectId);assert.equal(v.principalId,d.principalId);assert.equal(v.principalRevision,d.principalRevision);assert.equal(v.policyDigest,d.policyDigest);assert.equal(v.bindingContextDigest,d.bindingContextDigest);assert.deepEqual(v.subject,d.subject);
 for(const [key,expected] of Object.entries({instanceId:i.id,pinsDigest:i.pinsDigest,definitionRevisionId:i.pins.definitionRevisionId,semanticDigest:i.pins.semanticDigest,requirementsDigest:i.pins.requirementsDigest,candidateDigest:i.candidateDigest,channel:i.definition.semantic.config.publication.channel}))assert.equal(d.subject[key],expected);
 const m=v.releaseMaterial,{digest:md,...mb}=m;assert.equal(md,digest(mb));assert.equal(d.subject.releaseMaterialDigest,md);assert.equal(m.stageRequestId,r.id);assert.equal(m.requestDigest,r.digest);assert.equal(m.planDigest,r.planDigest);assert.equal(m.candidateDigest,i.candidateDigest);assert.equal(m.bindingContextDigest,d.bindingContextDigest);assert.equal(m.releaseAuthorized,false);
 const subject={instanceId:i.id,candidateDigest:i.candidateDigest,expiresAt:d.subject.expiresAt},input={kind:'release',subject,reviewDigest:d.reviewDigest,decision:'REJECT',evidenceRef:d.evidenceRef};
 assert.equal(receipt.operation,'lifecycle.authority.record');assert.equal(receipt.projectId,d.projectId);assert.equal(receipt.principalId,d.principalId);assert.equal(receipt.requestDigest,digest({operation:receipt.operation,projectId:d.projectId,input}));assert.equal(receipt.result.status,'REJECTED');assert.equal(receipt.result.authorityRef,ref);assert.equal(receipt.result.kind,'release');assert.equal(receipt.result.reviewDigest,d.reviewDigest);assert.equal(receipt.result.instanceId,i.id);assert.equal(receipt.result.executionDispatched,false);
 const decisions=events.filter(e=>e.type==='authority-recorded'&&e.data.kind==='release'&&e.data.instanceId===i.id);assert(decisions.length);const last=decisions.at(-1);assert.equal(last.data.authorityRef,ref);assert.equal(last.data.choice,'REJECT');assert.equal(last.data.reviewDigest,d.reviewDigest);assert.equal(last.data.principalId,d.principalId);assert.equal(last.revision,receipt.revision);assert.equal(last.at,receipt.at);assert(Number.isFinite(Date.parse(d.at))&&Date.parse(d.at)<=Date.parse(receipt.at)&&Date.parse(receipt.at)<=now);
 assert(!events.some(e=>e.type==='authority-revoked'&&(e.data.authorityRef===ref||e.data.kind==='release'&&e.data.instanceId===i.id)&&e.seq>=last.seq),'NOT_READY: release decision was revoked');
 return{decisionRef:ref,decisionRequestId:receipt.requestId,reviewDigest:d.reviewDigest,nativeStageStatus:stage.status,decision:'REJECT',nativeStageFailureClaimed:false};
}

export async function executeE18(callableContext) {
 const run=await openScenario('E18',undefined,callableContext);
 try{
  if(run.cases.every(c=>c.caseInstanceId==='E18.CV03')){for(const c of run.cases)await run.collect(c,()=>collectManagedBudget(run,c));return;}
  if(run.cases.every(c=>c.caseInstanceId==='E18.CV07')){for(const c of run.cases)await run.collect(c,()=>collectCoverageInventory(run,c));return;}
  assert(run.selection.ciAuthority,'Select the protected original CI/authority fixture; a historical source-test report is not a fixture');
  const fixture=pinned(run.selection.ciAuthority);
  keys(fixture,['schema','candidateDigest','workspaceId','projectId','syntheticAssets','syntheticDecisions','casePlans']);
  assert.equal(fixture.schema,'runtime-v090-ci-authority-fixture/v1');assert.equal(fixture.candidateDigest,run.candidateDigest);
  assert.equal(fixture.workspaceId,run.selection.workspaceId);assert.equal(fixture.projectId,run.selection.projectId);
  assert.equal(fixture.syntheticAssets,true);assert.equal(fixture.syntheticDecisions,true);
  assert(fixture.casePlans&&typeof fixture.casePlans==='object'&&!Array.isArray(fixture.casePlans));
  for(const id of Object.keys(fixture.casePlans))assert(run.all.some(c=>c.caseInstanceId===id),'Fixture cannot introduce a new acceptance case');
  const installed=path.join(run.selection.installedRoot,'package');
  const load=relative=>import(pathToFileURL(path.join(installed,'dist',relative)).href);
  const {evidenceValueDigest:evidenceDigest}=await load('server/errors.js');
  const base=await load('lifecycle/base.js'),instanceApi=await load('lifecycle/instance.js'),platformApi=await load('adapters/platforms.js');
  const configApi=await load('adapters/config.js'),artifactApi=await load('adapters/artifacts.js'),security=await load('server/security.js');
  const spec=read(path.join(run.selection.installedRoot,'service-specification.json'));
  const actor=()=>{const value=security.currentPrincipal(path.join(run.selection.installedRoot,'data'),run.selection.workspaceId,spec.principalId);assert(value,'The selected native principal no longer exists');return value;};
  const configuration=()=>{assert(spec.integrationsRef,'Real registered provider and owner connections are required');return configApi.readIntegrationConfiguration(spec.integrationsRef,run.selection.workspaceId);};
  let archiveSequence=0;
  async function installedInstance(id){
   const result=await run.read('lifecycle.instance.inspect',{instanceId:id});
   const value=instanceApi.inspectInstance(result.instance);assert.equal(value.id,id);assert.equal(value.pins.projectId,run.selection.projectId);
   assert.equal(base.isCurrentBase(value.pins.base),true,'Historical migrated instances cannot establish current stage admission');
   return value;
  }
  async function original(id){
   assert.equal(typeof id,'string');const result=await run.read('lifecycle.stage.request.inspect',{stageRequestId:id});
   const r=result.request,{digest,...body}=r;assert.equal(digest,base.valueDigest(body));assert.equal(r.planDigest,base.valueDigest(r.plan));
   assert.equal(r.id,id);assert.equal(r.workspaceId,run.selection.workspaceId);assert.equal(r.projectId,run.selection.projectId);
   assert.equal(result.automaticRedispatch,false);assert.equal(result.progress.requestId,id);
   const instance=await installedInstance(r.instanceId);assert.equal(instance.pinsDigest,r.pinsDigest);
   assert.equal(instance.stages[r.stageId].requestId,id);assert.equal(instance.stages[r.stageId].inputDigest,r.inputDigest);
   if(result.progress.observationRef){
    const value=await run.read('lifecycle.stage.observation.read',{stageRequestId:id,observationRef:result.progress.observationRef});
    assert.equal(base.valueDigest(value.evidence),value.observationRef);assert.deepEqual(value.evidence.observation,result.progress.observation);
    assert.equal(value.evidence.reason,result.progress.reason);assert.equal(value.evidence.observedAt,result.progress.observedAt);
   }
   return{...result,instance};
  }
  async function rejection(label,work,codes){
   let error;
   try{await work();}catch(e){error={code:e.code??null,message:e.message};}
   run.artifact('installed-negative-input.json',{label,error,expectedCodes:codes,negativeInputOnly:true,originalProviderResponseModified:false});
   assert(error,'Installed product accepted '+label);assert(codes.includes(error.code),'Unexpected rejection for '+label+': '+JSON.stringify(error));
   return error;
  }
  async function absentInstance(id){
   const result=await run.request('lifecycle.instance.inspect',{instanceId:id});
   assert.equal(result.status,404);assert.equal(result.body.error?.code,'NOT_FOUND');
  }
  async function activeDefinition(id,provider){
   const active=await run.read('lifecycle.definition.inspect');assert.equal(active.active?.id,id);
   const definition=await run.read('lifecycle.definition.read',{revisionId:id});
   assert.equal(definition.compilation.valid,true);assert.equal(definition.compilation.effective.semantic.config.implementation.provider,provider);
   assert.equal(base.isCurrentBase(definition.compilation.effective.base),true);
   assert.deepEqual(definition.compilation.effective.nodes.find(n=>n.id==='scope').dependsOn,[]);
   return{definition,yaml:await run.source(id)};
  }
  async function scopePrerequisite(c,plan){
   const {provider,predecessorOutcome}=c.parameters;assert.equal(c.parameters.stage,'scope');
   assert(['github','gitlab'].includes(provider));assert.notEqual(predecessorOutcome,'passed');
   if(predecessorOutcome==='not-run'||predecessorOutcome==='failed'){
    const missing=predecessorOutcome==='not-run';
    keys(plan,missing?['scopePrerequisite','subject','authorityRef']:['scopePrerequisite','instanceId','definitionRevisionId','authorityRef']);
    assert.equal(plan.scopePrerequisite,missing?'authority-not-recorded':'authority-rejected');
    assert(/^authority:sha256:[a-f0-9]{64}$/.test(plan.authorityRef));
    if(missing)keys(plan.subject,['instanceId','definitionRevisionId','goalRef','targetRef','loopRef','budget','expiresAt']);
    const instanceId=missing?plan.subject.instanceId:plan.instanceId,definitionRevisionId=missing?plan.subject.definitionRevisionId:plan.definitionRevisionId;
    await absentInstance(instanceId);const selected=await activeDefinition(definitionRevisionId,provider);
    const valid=await run.read('lifecycle.definition.validate',{yaml:selected.yaml});assert.equal(valid.ready,true,'A different missing configuration cannot replace the selected authority failure');
    const retained=await run.request('lifecycle.authority.inspect',{authorityRef:plan.authorityRef});
    if(missing){
     assert.equal(retained.status,404);assert.equal(retained.body.error?.code,'NOT_FOUND');
     const preview=await run.read('lifecycle.authority.preview',{kind:'execution',subject:plan.subject});
     assert.equal(preview.authorityGranted,false);assert.equal(preview.executionDispatched,false);assert.equal(preview.subject.instanceId,instanceId);
     assert(preview.preparation,'Use the current native preparation; a fake ref or unprepared subject cannot establish not-run');
     assert.equal(preview.preparation.input.definitionRevisionId,definitionRevisionId);
    }else{
     assert.equal(retained.status,200,JSON.stringify(retained.body));const authority=retained.body.result;
     assert.equal(authority.decision.kind,'execution');assert.equal(authority.decision.choice,'REJECT');
     assert.equal(authority.decision.subject.instanceId,instanceId);assert.equal(authority.decision.subject.definitionRevisionId,definitionRevisionId);
     assert.equal(authority.usable,false);assert.equal(authority.reason,'AUTHORITY_REVOKED');
     assert(authority.decision.subject.targetRef.startsWith('preparation:sha256:'));
     const preparation=await run.read('lifecycle.preparation.read',{preparationRef:authority.decision.subject.targetRef});assert.equal(preparation.current,true);
     assert.equal(preparation.packet.input.definitionRevisionId,definitionRevisionId);
    }
    const before=await run.read('runtime.status');
    const rejected=await run.request('lifecycle.instance.create',{instanceId,definitionRevisionId,authorityRef:plan.authorityRef},{requestId:run.requestId(c.caseInstanceId,'scope-entry-denial'),expectedRevision:before.revision});
    assert.equal(rejected.status,missing?404:403);assert.equal(rejected.body.error?.code,missing?'NOT_FOUND':'AUTHORITY_REVOKED');
    await absentInstance(instanceId);assert.equal((await run.read('runtime.status')).revision,before.revision,'Denied entry must not create an instance, decision or request');
    return{provider,stage:'scope',predecessorOutcome,scopePrerequisite:plan.scopePrerequisite,boundary:'lifecycle.instance.create',actualNativeRejection:rejected.body.error.code,decisionCreated:false,instanceCreated:false,executionDispatched:false};
   }
   const missing=predecessorOutcome==='missing-evidence';assert(missing||predecessorOutcome==='unknown');
   keys(plan,missing?['scopePrerequisite','instanceId','authorityRef','documentRole']:['scopePrerequisite','instanceId','authorityRef']);
   assert.equal(plan.scopePrerequisite,missing?'required-preparation-document-missing':'binding-observation-unknown');
   const before=await installedInstance(plan.instanceId),stage=before.stages.scope;
   assert.deepEqual(before.definition.nodes.find(n=>n.id==='scope').dependsOn,[]);assert.equal(before.definition.semantic.config.implementation.provider,provider);
   assert.equal(stage.status,'PENDING');assert.equal(stage.attempts,0);assert.equal(stage.requestId,null);
   const authority=await run.read('lifecycle.authority.inspect',{authorityRef:plan.authorityRef});
   assert.equal(authority.decision.kind,'execution');assert.equal(authority.decision.choice,'APPROVE');assert.equal(authority.decision.subject.instanceId,before.id);
   assert.equal(authority.decision.subject.definitionRevisionId,before.pins.definitionRevisionId);assert.equal(authority.decision.subject.targetRef,before.pins.targetRef);
   const preparation=await run.read('lifecycle.preparation.read',{preparationRef:before.pins.targetRef});
   assert.equal(preparation.packet.input.definitionRevisionId,before.pins.definitionRevisionId);assert.equal(preparation.packet.input.source.provider,provider);
   if(missing){
    assert(['plan','impact','verification','rollback'].includes(plan.documentRole),'Select a required prepared document, never an optional future-stage output');
    const document=preparation.packet.input.documents[plan.documentRole];assert(document&&hash.test(document.digest));assert(path.isAbsolute(document.path));
    let observedError;try{fs.lstatSync(document.path);}catch(error){observedError=error.code;}
    assert.equal(observedError,'ENOENT','The exact native preparation document must actually be missing');
    assert.equal(preparation.current,false);assert.equal(preparation.reason,'PREPARATION_UNAVAILABLE');assert.equal(authority.usable,false);assert.equal(authority.reason,'ENOENT');
    run.artifact('scope-missing-native-evidence.json',{instanceId:before.id,preparationRef:before.pins.targetRef,documentRole:plan.documentRole,document,observedError,originalPacketRetained:true,fileChangedByCollector:false});
   }else{
    assert.equal(preparation.current,true);assert.equal(authority.usable,true);
    const yaml=await run.source(before.pins.definitionRevisionId),validation=await run.read('lifecycle.definition.validate',{yaml});
    assert.equal(validation.compilation.valid,true);assert.equal(validation.ready,false);
    assert(validation.bindings?.issues.some(issue=>issue.code==='BINDINGS_UNKNOWN'),'A real unresolved dependency observation is required; invalid fields, explicit 403 or known missing evidence are separate conditions');
   }
   const denied=await run.request('lifecycle.stage.admission',{instanceId:before.id,stageId:'scope'});
   if(missing){assert.equal(denied.status,409);assert.equal(denied.body.error?.code,'AUTHORITY_UNKNOWN');}
   else{assert.equal(denied.status,200,JSON.stringify(denied.body));assert.equal(denied.body.result.allowed,false);assert.deepEqual(denied.body.result.reasons,['BINDINGS_NOT_CURRENT']);assert.equal(denied.body.result.executionDispatched,false);}
   const after=await installedInstance(before.id);assert.deepEqual(after,before);
   assert.deepEqual((await run.read('lifecycle.preparation.read',{preparationRef:before.pins.targetRef})).packet,preparation.packet);
   return{provider,stage:'scope',predecessorOutcome,scopePrerequisite:plan.scopePrerequisite,boundary:'lifecycle.stage.admission',actualNativeRejection:missing?denied.body.error.code:denied.body.result.reasons[0],instancePinsUnchanged:true,originalPreparationUnchanged:true,executionDispatched:false};
  }
  const evidenceOperation={scope:'lifecycle.scope.evidence.read',plan:'lifecycle.plan.evidence.read','release-decision':'lifecycle.release.evidence.read',publication:'lifecycle.publication.evidence.read'};
  async function missingEvidence(retained){
   const r=retained.request,operation=evidenceOperation[r.stageId];let readback=null,history=[];
   if(operation){readback=await run.request(operation,{stageRequestId:r.id});
    if(r.stageId==='release-decision'&&readback.status===409&&readback.body.error?.code==='RELEASE_MATERIAL_REQUIRED'){
     const events=await readE18Events(run.read);for(const e of events.filter(e=>e.type==='stage-observed'&&e.data.stageRequestId===r.id&&e.data.phase==='UNKNOWN')){assert(hash.test(e.data.observationRef));const value=await run.read('lifecycle.stage.observation.read',{stageRequestId:r.id,observationRef:e.data.observationRef});assert.equal(value.evidence.reason,e.data.reason);history.push(value);}
    }
   }
   const proof=classifyE18MissingEvidence(retained,readback,history,evidenceDigest);
   return{proof,readback,history};
  }
  async function verifyPublicationMissingArchive(retained,selected){
   const r=retained.request,p=r.plan.parameters,v=selected.readback.body.result,binding=configApi.configuredPlatform(configuration(),actor(),r.projectId,p.binding.ref);assert.deepEqual(binding,p.binding);
   const client=(await load('adapters/'+binding.provider+'.js'))[binding.provider+'Client'](binding,async(b,a,signal)=>{signal.throwIfAborted();return configApi.readPlatformToken(spec.integrationsRef,b,a);});
   const request=platformApi.validateRunRequest(v.ciRequest,binding),remaining=()=>{const ms=Date.parse(r.deadlineAt)-Date.now();assert(ms>0,'NOT_READY: original publication deadline expired');return AbortSignal.timeout(Math.min(60000,ms));};
   const observed=await client.run(actor(),request,v.run.runId,remaining());assert.equal(observed.status,'PASSED');assert.equal(observed.runId,v.run.runId);assert.equal(observed.requestId,request.requestId);
   const archive=await client.artifact(actor(),request,v.run.runId,remaining());assert.equal(archive.archiveDigest,'sha256:'+sha(archive.bytes));assert.equal(archive.archiveBytes,archive.bytes.length);
   let error;try{await artifactApi.verifyCiArtifact(archive,request,p.expectedChecks,remaining());}catch(e){error=e.code;}assert.equal(error,'CI_RESULT_MISSING','Original actual publication archive must independently reproduce the native missing-result reason');remaining();
   const filename='actual-missing-publication-'+(++archiveSequence)+'.zip';fs.writeFileSync(path.join(run.selection.outputRoot,filename),archive.bytes,{mode:0o600,flag:'wx'});const {bytes,...metadata}=archive;
   run.artifact('publication-missing-original-archive.json',{filename,request,observed,metadata,reason:error,remoteWritesByCollector:0});
  }
  async function currentReleaseRejection(c,plan){
   keys(plan,['instanceId','predecessorId','authorityRef','decisionRequestId']);assert.equal(plan.predecessorId,'release-decision');assert(/^authority:sha256:[a-f0-9]{64}$/.test(plan.authorityRef));assert(typeof plan.decisionRequestId==='string'&&plan.decisionRequestId);
   const instance=await installedInstance(plan.instanceId);assert.equal(instance.definition.semantic.config.implementation.provider,c.parameters.provider);assert(instance.definition.nodes.find(n=>n.id==='publication').dependsOn.includes('release-decision'));
   const retained=await original(instance.stages['release-decision'].requestId),authority=await run.read('lifecycle.authority.inspect',{authorityRef:plan.authorityRef}),d=authority.decision,subject={instanceId:instance.id,candidateDigest:instance.candidateDigest,expiresAt:d.subject.expiresAt};
   const executionAuthority=await run.read('lifecycle.authority.inspect',{authorityRef:retained.request.authorityRef}),definitionSource=await run.source(instance.pins.definitionRevisionId);assert.equal((await run.read('lifecycle.definition.validate',{yaml:definitionSource})).ready,true,'NOT_READY: unrelated binding failure cannot replace exact release rejection');
   const principal=actor();assert.equal(principal.id,d.principalId);assert.equal(principal.revision,d.principalRevision);assert.equal(d.subject.instanceId,instance.id);
   const receipt=await run.read('runtime.receipt.read',{requestId:plan.decisionRequestId});assert.equal(receipt.requestId,plan.decisionRequestId);
   const {verifyDecisionEvidence}=await import(pathToFileURL(path.join(installed,'vendor/compatibility/v1/decision-evidence.mjs')).href),expected={owner:'runtime',operation:'lifecycle.authority.release',workspaceId:run.selection.workspaceId,scope:{visibility:'private',projectId:run.selection.projectId},reviewDigest:d.reviewDigest,decision:'REJECT'};
   verifyDecisionEvidence(d.evidenceRef,expected);const decisionOriginals=readE18DecisionOriginals(d.evidenceRef);
   const material=await run.read('lifecycle.release.evidence.read',{stageRequestId:retained.request.id}),preview=await run.read('lifecycle.authority.preview',{kind:'release',subject});assert.deepEqual(material.material,preview.releaseMaterial);
   const events=await readE18Events(run.read),input={instance,retained,authority,preview,receipt,events,principal,executionAuthority},proof=assertE18CurrentReleaseRejection(input,evidenceDigest);
   const admission=await run.request('lifecycle.stage.admission',{instanceId:instance.id,stageId:'publication'});assert.equal(admission.status,403);assert.equal(admission.body.error?.code,'AUTHORITY_REVOKED');
   const after=await installedInstance(instance.id);assert.deepEqual(after,instance);const finalRetained=await original(retained.request.id);assert.deepEqual(finalRetained.request,retained.request);assert.deepEqual(finalRetained.progress,retained.progress);
   const finalAuthority=await run.read('lifecycle.authority.inspect',{authorityRef:plan.authorityRef});const {projectRevision:unusedRevision,...finalDecision}=finalAuthority,{projectRevision:unusedOriginal,...originalDecision}=authority;assert.deepEqual(finalDecision,originalDecision);
   assert.deepEqual(await run.read('runtime.receipt.read',{requestId:plan.decisionRequestId}),receipt);assert.deepEqual(await run.read('lifecycle.release.evidence.read',{stageRequestId:retained.request.id}),material);verifyDecisionEvidence(d.evidenceRef,expected);assert.deepEqual(readE18DecisionOriginals(d.evidenceRef),decisionOriginals);
   const finalExecutionAuthority=await run.read('lifecycle.authority.inspect',{authorityRef:retained.request.authorityRef});assert.equal(finalExecutionAuthority.usable,true);assert.deepEqual(finalExecutionAuthority.decision,executionAuthority.decision);assert.equal((await run.read('lifecycle.definition.validate',{yaml:definitionSource})).ready,true);
   const finalPreview=await run.read('lifecycle.authority.preview',{kind:'release',subject});assert.deepEqual(finalPreview,preview);const finalEvents=await readE18Events(run.read);assert.deepEqual(finalEvents,events,'NOT_READY: native event inventory changed during rejection collection');assertE18CurrentReleaseRejection({...input,authority:finalAuthority,preview:finalPreview,events:finalEvents,principal:actor(),executionAuthority:finalExecutionAuthority},evidenceDigest);
   // Final file verification follows every awaited read; no async gap remains before retention.
   verifyDecisionEvidence(d.evidenceRef,expected);assert.deepEqual(readE18DecisionOriginals(d.evidenceRef),decisionOriginals);
   run.artifact('current-release-rejection.json',{proof,instance,request:retained.request,progress:retained.progress,authority,executionAuthority,preview,receipt,events,admission,decisionOriginals,remoteWritesByCollector:0,decisionEvidenceVerified:true});
   return{provider:c.parameters.provider,stage:'publication',predecessorOutcome:'failed',instanceId:instance.id,predecessorId:'release-decision',...proof,boundary:'lifecycle.stage.admission',actualNativeRejection:'AUTHORITY_REVOKED',executionDispatched:false};
  }
  async function stageAdmission(c,plan){
   if(c.parameters.stage==='publication'&&c.parameters.predecessorOutcome==='failed')return currentReleaseRejection(c,plan);
   keys(plan,['instanceId','predecessorId']);const {provider,stage,predecessorOutcome}=c.parameters;
   let originalPredecessor,selectedMissing;
   assert(['github','gitlab'].includes(provider)&&stages.includes(stage)&&outcomes.includes(predecessorOutcome));
   const before=await installedInstance(plan.instanceId),node=before.definition.nodes.find(n=>n.id===stage);
   assert(node);assert.equal(before.definition.semantic.config.implementation.provider,provider);
   assert.equal(before.stages[stage].status,'PENDING','Use the actual pre-admission state, not a completed-stage denial');
   assert.equal(before.stages[stage].attempts,0,'A retry budget failure cannot stand in for a predecessor failure');
   if(stage==='scope'){
    assert.equal(plan.predecessorId,null);assert.deepEqual(node.dependsOn,[]);
    assert.equal(predecessorOutcome,'passed','Scope negative outcomes use their distinct native entry prerequisites');
    assert(before.pins.targetRef.startsWith('preparation:sha256:'),'Scope needs its exact native preparation');
    const preparation=await run.read('lifecycle.preparation.read',{preparationRef:before.pins.targetRef});
    assert.equal(preparation.current,true);assert.equal(preparation.packet.input.definitionRevisionId,before.pins.definitionRevisionId);
    assert.equal(preparation.packet.input.source.provider,provider);assert.equal(preparation.executionAuthorized,false);
    run.artifact('scope-native-preparation.json',preparation);
   }else{
    assert(node.dependsOn.includes(plan.predecessorId),'Select an actual graph predecessor, not a convenient other stage');
    const prior=before.stages[plan.predecessorId];assert(prior);
    if(predecessorOutcome==='not-run'){
     assert.equal(prior.status,'PENDING');assert.equal(prior.attempts,0);assert.equal(prior.requestId,null);assert.equal(prior.receiptRef,null);
    }else{
     assert(prior.requestId);const retained=await original(prior.requestId),observation=retained.progress.observation;
     assert(observation,'A state label alone is insufficient; retain the actual provider/adapter outcome');
     assert.equal(observation.outcome.requestId,prior.requestId);assert.equal(observation.outcome.inputDigest,prior.inputDigest);
     assert.equal(prior.outcomeDigest,base.valueDigest(observation.outcome));
     originalPredecessor=retained;const expected=before.definition.nodes.find(n=>n.id===plan.predecessorId).checks;
     if(['unknown','missing-evidence'].includes(predecessorOutcome))selectedMissing=await missingEvidence(retained);
     if(predecessorOutcome==='failed'){
      assert.equal(prior.status,'FAILED');assert.equal(observation.outcome.status,'FAILED');
      assert.equal(observation.phase,'FAILED');assert.equal(retained.progress.terminal,true);
     }else if(predecessorOutcome==='unknown'){
      assert.equal(prior.status,'UNKNOWN');assert.equal(observation.outcome.status,'UNKNOWN');
      assert.equal(selectedMissing.proof,null,'An authenticated missing original has its own fixed case');
      assert(!missingEvidenceReasons.includes(retained.progress.reason),'A specific missing-evidence rejection has its own fixed case');
      assert(retained.progress.reason||observation.handle||observation.outcome.checks.some(check=>check.status==='UNKNOWN'),'Retain an actual uncertain request/handle/check or native reason');
     }else if(predecessorOutcome==='missing-evidence'){
      assert(selectedMissing.proof,'An empty observation alone does not prove missing evidence; retain the exact native missing original');
      assert.equal(prior.status,selectedMissing.proof.kind==='release-original-material-absent'?selectedMissing.proof.nativePhase:'UNKNOWN');assert.equal(observation.outcome.status,prior.status);
      if(selectedMissing.proof.kind==='publication-original-result-absent')await verifyPublicationMissingArchive(retained,selectedMissing);
      run.artifact('native-missing-evidence.json',{request:retained.request,progress:retained.progress,...selectedMissing,executionDispatched:false});
      const found=new Set(observation.outcome.checks.map(check=>check.id));assert(expected.some(id=>!found.has(id)),'The original observation must actually omit a required evidence item');
      assert(!observation.outcome.checks.some(check=>check.status==='FAIL'||check.status==='UNKNOWN'),'Do not relabel an explicit failed/unknown check as missing evidence');
     }else{
      assert.equal(prior.status,'PASSED');assert.equal(observation.outcome.status,'COMPLETE');
      assert.deepEqual(observation.outcome.checks.map(check=>check.id).sort(),[...expected].sort());
      assert(observation.outcome.checks.every(check=>check.status==='PASS'&&check.evidenceRef));
      assert(Date.parse(prior.expiresAt)>Date.now(),'Historical successful evidence is not current admission');
     }
    }
   }
   const response=await run.request('lifecycle.stage.admission',{instanceId:before.id,stageId:stage});
   assert.equal(response.status,200,'Authority/provider failure must not masquerade as a predecessor admission result: '+JSON.stringify(response.body));
   const admission=response.body.result;assert.equal(admission.executionDispatched,false);
   assert.equal(admission.allowed,predecessorOutcome==='passed');
   if(predecessorOutcome==='passed')assert.deepEqual(admission.reasons,[]);
   else assert(admission.reasons.includes('PREDECESSOR_NOT_PASSED:'+plan.predecessorId));
   const after=await installedInstance(before.id);assert.deepEqual(after,before,'Read-only admission changed the original instance');
   if(selectedMissing){const finalOriginal=await original(originalPredecessor.request.id);assert.deepEqual(finalOriginal.request,originalPredecessor.request);assert.deepEqual(finalOriginal.progress,originalPredecessor.progress);const finalMissing=await missingEvidence(finalOriginal);assert.deepEqual(e18MissingEvidenceIdentity(finalMissing),e18MissingEvidenceIdentity(selectedMissing),'NOT_READY: original missing-evidence readback changed during admission');}
   return{provider,stage,predecessorOutcome,instanceId:before.id,predecessorId:plan.predecessorId,admission,actualNativeObservation:true,...(selectedMissing?.proof?{missingEvidence:selectedMissing.proof,nativePredecessorStatus:before.stages[plan.predecessorId].status}:{}),executionDispatched:false};
  }
  function ciRequest(r){
   const p=r.plan.parameters;
   assert(['candidate','verification'].includes(r.stageId),'Select an original native candidate/verification CI stage');
   assert.equal(r.plan.adapterId,'runtime-ci-owner-stage-v2');assert.equal(p.stageId,r.stageId);
   assert.equal(p.commit,p.source.commit);
   return platformApi.validateRunRequest({schema:'runtime-ci-request/v1',requestId:'stage-'+base.valueDigest({workspaceId:r.workspaceId,projectId:r.projectId,requestId:r.id}).slice(7,55),projectId:r.projectId,bindingDigest:base.valueDigest(p.binding),commit:p.commit,workflowDigest:p.workflowDigest,inputDigest:r.inputDigest,stageId:r.stageId,candidateDigest:p.candidateDigest,...(p.candidateInput?{candidateInput:p.candidateInput}:{}),requestedAt:r.requestedAt,deadlineAt:r.deadlineAt},p.binding);
  }
  async function providerOriginal(provider,selected){
   keys(selected,['stageRequestId','runId']);assert(/^[1-9][0-9]{0,19}$/.test(selected.runId));
   const retained=await original(selected.stageRequestId),r=retained.request,p=r.plan.parameters;
   assert.equal(p.binding.provider,provider);assert.equal(retained.instance.definition.semantic.config.implementation.provider,provider);
   assert.deepEqual(p.expectedChecks,retained.instance.definition.nodes.find(n=>n.id===r.stageId).checks);
   const binding=configApi.configuredPlatform(configuration(),actor(),run.selection.projectId,p.binding.ref);assert.deepEqual(binding,p.binding);
   const credentials=async(value,principal,signal)=>{signal.throwIfAborted();return configApi.readPlatformToken(spec.integrationsRef,value,principal);};
   const api=await load('adapters/'+provider+'.js'),client=api[provider+'Client'](binding,credentials),transport=platformApi.platformReader(binding,credentials);
   const request=ciRequest(r);
   const raw=await transport.get(actor(),provider==='github'?'/actions/runs/'+selected.runId:'/pipelines/'+selected.runId,AbortSignal.timeout(15000));
   run.artifact('actual-platform-run.json',{provider,selected,raw,installation:run.candidateDigest});
   assert.equal(String(raw.id),selected.runId);
   return{retained,request,binding,client,transport,raw,runId:selected.runId};
  }
  async function actualRun(source){
   const value=await source.client.run(actor(),source.request,source.runId,AbortSignal.timeout(30000));
   run.artifact('actual-platform-observation.json',value);assert.equal(value.runId,source.runId);assert.equal(value.requestId,source.request.requestId);
   assert.equal(value.commit,source.request.commit);assert.equal(value.artifactsVerified,false);assert.equal(value.lifecycleAcceptance,false);
   return value;
  }
  async function releaseMismatch(plan,provider){
   keys(plan,['instanceId','authorityRef']);const before=await installedInstance(plan.instanceId);
   assert.equal(before.definition.semantic.config.implementation.provider,provider);assert(before.candidateDigest);
   assert.equal(before.stages.publication.status,'PENDING');assert.equal(before.stages.publication.attempts,0);
   if(plan.authorityRef!==null){
    const originalAuthority=await run.read('lifecycle.authority.inspect',{authorityRef:plan.authorityRef});
    assert.equal(originalAuthority.decision.kind,'release');assert.equal(originalAuthority.decision.subject.instanceId,before.id);assert.equal(originalAuthority.usable,false);
    assert(['AUTHORITY_REVOKED','AUTHORITY_SUPERSEDED','AUTHORITY_EXPIRED','AUTHORITY_POLICY_CHANGED','AUTHORITY_BINDINGS_CHANGED','AUTHORITY_PRINCIPAL_CHANGED','AUTHORITY_MISMATCH','RELEASE_MATERIAL_CHANGED'].includes(originalAuthority.reason));
   }
   const preview=await run.request('lifecycle.authority.preview',{kind:'release',subject:{instanceId:before.id,candidateDigest:differentDigest(before.candidateDigest),expiresAt:new Date(Date.now()+60000).toISOString()}});
   assert.equal(preview.status,409);assert.equal(preview.body.error?.code,'CANDIDATE_REQUIRED');
   const admission=await run.request('lifecycle.stage.admission',{instanceId:before.id,stageId:'publication'});
   if(admission.status===200){assert.equal(admission.body.result.allowed,false);assert(admission.body.result.reasons.includes('EXACT_RELEASE_AUTHORITY_REQUIRED'));}
   else assert(['AUTHORITY_REVOKED','AUTHORITY_SUPERSEDED','AUTHORITY_EXPIRED','AUTHORITY_POLICY_CHANGED','AUTHORITY_BINDINGS_CHANGED','AUTHORITY_PRINCIPAL_CHANGED','AUTHORITY_MISMATCH','RELEASE_MATERIAL_CHANGED'].includes(admission.body.error?.code),'Unrelated failure cannot establish missing release authority');
   assert.deepEqual(await installedInstance(before.id),before);return{wrongCandidatePreviewRejected:true,exactReleaseAdmissionRejected:true,authorityCreated:false,publicationDispatched:false};
  }
  async function publicationInspection(plan,provider,c){
   keys(plan,['stageRequestId','unknownObservationRef','allowReconciliation']);assert.equal(plan.allowReconciliation,true);assert(hash.test(plan.unknownObservationRef));
   const before=await original(plan.stageRequestId);assert.equal(before.request.stageId,'publication');assert.equal(before.request.plan.parameters.binding.provider,provider);
   assert.equal(before.progress.phase,'UNKNOWN');assert.equal(before.progress.terminal,false,'Select the unresolved original publication, not a completed happy path');
   const old=await run.read('lifecycle.stage.observation.read',{stageRequestId:plan.stageRequestId,observationRef:plan.unknownObservationRef});
   assert.equal(base.valueDigest(old.evidence),plan.unknownObservationRef);assert.equal(old.evidence.observation.phase,'UNKNOWN');assert.equal(old.evidence.observation.outcome.status,'UNKNOWN');
   const facts=await run.read('lifecycle.publication.evidence.read',{stageRequestId:plan.stageRequestId});
   assert(facts.ciRequest,'Require an actual retained original dispatch, not a pre-dispatch error');assert.equal(facts.automaticRedispatch,false);
   assert.equal(facts.ciRequest.inputDigest,before.request.inputDigest);assert.equal(facts.ciRequest.candidateDigest,before.instance.candidateDigest);
   const binding=configApi.configuredPlatform(configuration(),actor(),run.selection.projectId,before.request.plan.parameters.binding.ref);assert.deepEqual(binding,before.request.plan.parameters.binding);
   const api=await load('adapters/'+provider+'.js'),client=api[provider+'Client'](binding,async(value,principal,signal)=>{signal.throwIfAborted();return configApi.readPlatformToken(spec.integrationsRef,value,principal);});
   const initialRun=await client.run(actor(),facts.ciRequest,null,AbortSignal.timeout(30000));
   run.artifact('publication-original-provider-lookup.json',initialRun);
   const status=await run.read('runtime.status'),requested=await run.request('lifecycle.stage.reconcile',{stageRequestId:plan.stageRequestId},{requestId:run.requestId(c.caseInstanceId,provider+'-publication-reconcile'),expectedRevision:status.revision});
   assert.equal(requested.status,200,JSON.stringify(requested.body));assert.equal(requested.body.result.result.automaticRedispatch,false);
   const deadline=Date.now()+30000;let worker;
   do{worker=(await run.read('runtime.status')).observationWorker;if(worker.inFlight===0)break;await pause(250);}while(Date.now()<deadline);
   assert.equal(worker.inFlight,0,'Original reconciliation did not settle within the selected observation bound');
   const after=await original(plan.stageRequestId);
   const next=await run.read('lifecycle.publication.evidence.read',{stageRequestId:plan.stageRequestId});
   assert.deepEqual(next.ciRequest,facts.ciRequest);assert.deepEqual(after.instance.requestIds,before.instance.requestIds);assert.equal(after.instance.stages.publication.attempts,before.instance.stages.publication.attempts);
   assert.equal(next.automaticRedispatch,false);
   const finalRun=await client.run(actor(),facts.ciRequest,null,AbortSignal.timeout(30000));
   if(initialRun.runId!==null)assert.equal(finalRun.runId,initialRun.runId);
   const releaseStage=before.instance.stages['release-decision'];assert(releaseStage.requestId);
   const material=(await run.read('lifecycle.release.evidence.read',{stageRequestId:releaseStage.requestId})).material;
   const distributionApi=await load('adapters/distribution.js'),publication=facts.ciRequest.publicationInput;
   const description=distributionApi.publicationDescription(material.documents.documents.filter(d=>d.role==='release-notes').map(d=>d.text),facts.ciRequest);
   const distribution=await client.distribution(actor(),{commit:facts.ciRequest.commit,candidate:before.instance.candidate,tag:publication.tag,prerelease:publication.target.prerelease,packageName:publication.target.packageName,descriptionDigest:'sha256:'+sha(description)},AbortSignal.timeout(60000));
   run.artifact('publication-independent-readback.json',{initialRun,finalRun,distribution,retainedEvidence:next,worker,originalInspectionRequested:true,remoteWritesByCollector:0});
   assert(['ABSENT','PARTIAL','MISMATCH','PASSED'].includes(distribution.status));assert.equal(distribution.releaseAuthorized,false);
   if(distribution.status!=='PASSED')assert.notEqual(after.progress.phase,'COMPLETE');
   return{originalUnknown:plan.unknownObservationRef,originalRequestUnchanged:true,newAttempt:false,observedDistribution:distribution.status,phase:after.progress.phase,independentProviderLookupUnique:true};
  }
  async function forkCredentialLoss(provider,plan){
   validateForkCredentialSelection(plan);const upstream=await providerOriginal(provider,{stageRequestId:plan.upstream.stageRequestId,runId:plan.upstream.runId}),fork=await providerOriginal(provider,{stageRequestId:plan.stageRequestId,runId:plan.runId});assert.notEqual(upstream.binding.repositoryId,fork.binding.repositoryId);assert.equal(upstream.request.commit,fork.request.commit,'NOT_READY: upstream/fork must retain the same exact source commit');assert.equal(upstream.request.workflowDigest,fork.request.workflowDigest);assert.notEqual(upstream.request.requestId,fork.request.requestId);
   const upstreamRepo=await upstream.transport.get(actor(),'',AbortSignal.timeout(15000)),forkRepo=await fork.transport.get(actor(),'',AbortSignal.timeout(15000));assertForkLineage(provider,upstreamRepo,forkRepo,upstream.binding.repositoryId,fork.binding.repositoryId);
   run.artifact('actual-fork-lineage.json',{provider,upstreamRepositoryId:upstream.binding.repositoryId,forkRepositoryId:fork.binding.repositoryId,upstreamRepo,forkRepo});
   const parseDocument=(await import(pathToFileURL(path.join(installed,'node_modules/yaml/dist/index.js')).href)).parseDocument;
   async function inspect(source,selected,state){
    const before=await original(selected.stageRequestId),observed=await actualRun(source),unique=await source.client.run(actor(),source.request,null,AbortSignal.timeout(30000));assert.equal(unique.runId,source.runId,'NOT_READY: exact native request must resolve to this unique original provider run');assert.equal(unique.factsDigest,observed.factsDigest);assert.equal(observed.status,state==='ABSENT'?'FAILED':'PASSED');if(state==='ABSENT')assert.notEqual(before.instance.stages[before.request.stageId].status,'PASSED');
    const workflowPath=provider==='github'?source.binding.workflowPath:source.binding.pipelinePath,route=provider==='github'?'/contents/'+workflowPath+'?ref='+source.request.commit:'/repository/files/'+encodeURIComponent(workflowPath)+'?ref='+source.request.commit,rawFile=await source.transport.get(actor(),route,AbortSignal.timeout(15000));assert.equal(rawFile.encoding,'base64');const workflow=platformApi.fileBytes(rawFile.content,rawFile.size);assert.equal('sha256:'+sha(workflow),source.request.workflowDigest);assert.equal(provider==='github'?rawFile.path:rawFile.file_path,workflowPath);if(provider==='gitlab'){assert.equal(rawFile.commit_id,source.request.commit);assert.equal('sha256:'+rawFile.content_sha256,source.request.workflowDigest);}const doc=parseDocument(workflow.toString('utf8'),{uniqueKeys:true});assert.deepEqual(doc.errors,[]);const definition=doc.toJS({maxAliasCount:32}),producer=assertForkProbeJob(provider,definition,source.binding,plan.credentialName);
    async function inventory(){const runs=await source.transport.get(actor(),provider==='github'?'/actions/runs?head_sha='+source.request.commit+'&per_page=100':'/pipelines?sha='+source.request.commit+'&per_page=100',AbortSignal.timeout(15000)),jobs=await source.transport.get(actor(),provider==='github'?'/actions/runs/'+source.runId+'/jobs?filter=all&per_page=100':'/pipelines/'+source.runId+'/jobs?include_retried=true&per_page=100',AbortSignal.timeout(15000));const rows=provider==='github'?runs.workflow_runs:runs,jobRows=provider==='github'?jobs.jobs:jobs;assert(Array.isArray(rows)&&rows.length<100&&Array.isArray(jobRows)&&jobRows.length<100,'NOT_READY: original bounded complete inventories required');assert(rows.some(r=>String(r.id)===source.runId));const ids=rows.map(r=>[String(r.id),provider==='github'?r.run_attempt:null]).sort(),jobIds=jobRows.map(j=>[String(j.id),j.name]).sort();assert.equal(new Set(ids.map(r=>r[0])).size,ids.length);assert.equal(new Set(jobIds.map(r=>r[0])).size,jobIds.length);return{runs:ids,jobs:jobIds};}
    const beforeInventory=await inventory(),jobRoute=provider==='github'?'/actions/jobs/'+selected.jobId:'/jobs/'+selected.jobId,job=await source.transport.get(actor(),jobRoute,AbortSignal.timeout(15000));assert.equal(String(job.id),selected.jobId);assert.equal(job.name,FORK_PROBE_JOB);assert.equal(beforeInventory.jobs.filter(j=>j[1]===FORK_PROBE_JOB).length,1);const nativeJob=await source.client.job(actor(),source.runId,selected.jobId,source.request.commit,AbortSignal.timeout(15000),platformApi.ciSourceRef(source.request));assert.equal(nativeJob.status,state==='ABSENT'?'FAILED':'PASSED');
    assertForkProbeJobObservation(provider,job,state);
    let metadata,downloadRoute,metadataRoute;
    if(provider==='github'){const list=await source.transport.get(actor(),'/actions/runs/'+source.runId+'/artifacts?per_page=100',AbortSignal.timeout(15000));assert(Array.isArray(list.artifacts)&&list.artifacts.length<100);const matches=list.artifacts.filter(a=>a.name===FORK_PROBE_JOB);assert.equal(matches.length,1,'NOT_READY: original unique probe archive required');metadata=matches[0];assert.equal(metadata.expired,false);assert.equal(String(metadata.workflow_run?.id),source.runId);assert.equal(String(metadata.workflow_run?.repository_id),source.binding.repositoryId);assert.equal(metadata.workflow_run.head_sha,source.request.commit);assert.equal(metadata.workflow_run.head_branch,platformApi.ciSourceRef(source.request));assert(hash.test(metadata.digest));downloadRoute='/actions/artifacts/'+metadata.id+'/zip';metadataRoute='/actions/artifacts/'+metadata.id;}
    else{metadata=assertForkGitLabArtifact(job);downloadRoute='/jobs/'+selected.jobId+'/artifacts';metadataRoute=jobRoute;}
    const size=provider==='github'?metadata.size_in_bytes:metadata.artifacts_file.size;assert(Number.isSafeInteger(size)&&size>0&&size<=1048576,'NOT_READY: bounded dedicated probe archive required');const bytes=await source.transport.download(actor(),downloadRoute,AbortSignal.timeout(60000));assert.equal(bytes.length,size);const digest='sha256:'+sha(bytes);if(provider==='github')assert.equal(digest,metadata.digest);const current=await source.transport.get(actor(),metadataRoute,AbortSignal.timeout(15000));assert.deepEqual(current,metadata,'Original probe archive/job changed during read');const files=await artifactApi.readArtifactArchive(bytes,AbortSignal.timeout(15000)),measurement=assertForkCredentialMeasurement(files,{provider,repositoryId:source.binding.repositoryId,runId:source.runId,request:source.request,credentialName:plan.credentialName,state});
    const file='actual-fork-credential-'+(++archiveSequence)+'.zip';fs.writeFileSync(path.join(run.selection.outputRoot,file),bytes,{mode:0o600,flag:'wx'});run.artifact('actual-fork-credential-probe.json',{provider,state,originalRequest:source.request,versionedWorkflow:workflow.toString('utf8'),producer,job,nativeJob,metadata,file,archiveDigest:digest,archiveBytes:size,measurement,originalStdout:files.get('fork-credential-probe.stdout').toString(),originalStderr:'',selectedCredentialValuesReturnedToCollector:false,selectedCredentialValuesRecorded:false});
    assert.deepEqual(await inventory(),beforeInventory,'Fork credential collection changed provider run/job counts');assert.deepEqual(await original(selected.stageRequestId),before);assert.deepEqual(await source.transport.get(actor(),route,AbortSignal.timeout(15000)),rawFile);return{requestId:source.request.requestId,runId:source.runId,jobId:selected.jobId,repositoryId:source.binding.repositoryId,state,archiveDigest:digest,sideEffectCounts:{newProviderRuns:0,newProviderJobs:0,newRuntimeRequests:0}};
   }
   const positive=await inspect(upstream,plan.upstream,'PRESENT'),negative=await inspect(fork,plan,'ABSENT');assert.deepEqual(await upstream.transport.get(actor(),'',AbortSignal.timeout(15000)),upstreamRepo);assert.deepEqual(await fork.transport.get(actor(),'',AbortSignal.timeout(15000)),forkRepo);return{upstream:positive,fork:negative,actualOriginalCI:true,missingCredentialNotInferredFromApiDenial:true,newDispatches:0,newCredentialMetadataApiReads:0};
  }
  async function providerMismatches(c,plan){
   validateForkCredentialSelection(plan?.forkCredential);keys(plan,['provider','passing','oldCandidate','rerun','skipped','release','publication','forkCredential']);const provider=plan.provider;assert(['github','gitlab'].includes(provider));
   if(c.caseInstanceId==='E18.variant.01')assert.equal(provider,'github');if(c.caseInstanceId==='E18.variant.02')assert.equal(provider,'gitlab');
   const source=await providerOriginal(provider,plan.passing),observed=await actualRun(source);assert.equal(observed.status,'PASSED');assert(observed.jobs.length>0);
   const archive=await source.client.artifact(actor(),source.request,source.runId,AbortSignal.timeout(60000));
   const verified=await artifactApi.verifyCiArtifact(archive,source.request,source.retained.request.plan.parameters.expectedChecks,AbortSignal.timeout(30000));
   assert.equal(verified.status,'PASSED');assert.equal(verified.lifecycleAcceptance,false);assert.equal(verified.ownerEvaluationsVerified,false);
   const filename='actual-ci-archive-'+(++archiveSequence)+'.zip';fs.writeFileSync(path.join(run.selection.outputRoot,filename),archive.bytes,{mode:0o600,flag:'wx'});
   const entries=await artifactApi.readArtifactArchive(archive.bytes,AbortSignal.timeout(30000));
   run.artifact('actual-ci-archive.json',{file:filename,archiveDigest:archive.archiveDigest,archiveBytes:archive.archiveBytes,verified,result:JSON.parse(entries.get('runtime-result.json').toString()),provider,runId:source.runId});
   const wrongCommit=(source.request.commit[0]==='0'?'1':'0')+source.request.commit.slice(1);
   await rejection('same original successful job with wrong commit',()=>source.client.job(actor(),source.runId,observed.jobs[0].jobId,wrongCommit,AbortSignal.timeout(15000),platformApi.ciSourceRef(source.request)),['PLATFORM_RECEIPT_MISMATCH']);
   await rejection('original bytes with forged archive digest',()=>artifactApi.verifyCiArtifact({...archive,archiveDigest:differentDigest(archive.archiveDigest)},source.request,verified.checks.map(v=>v.id),AbortSignal.timeout(15000)),['CI_ARTIFACT_MISMATCH']);
   await rejection('successful report from a different workflow pin',()=>artifactApi.verifyCiArtifact(archive,{...source.request,workflowDigest:differentDigest(source.request.workflowDigest)},verified.checks.map(v=>v.id),AbortSignal.timeout(15000)),['CI_RESULT_MISMATCH']);
   await rejection('old successful report reused for a different exact input',()=>artifactApi.verifyCiArtifact(archive,{...source.request,inputDigest:differentDigest(source.request.inputDigest)},verified.checks.map(v=>v.id),AbortSignal.timeout(15000)),['CI_ARTIFACT_MISMATCH']);
   const old=await providerOriginal(provider,plan.oldCandidate);assert.equal(old.request.stageId,'candidate');assert.notEqual(old.request.requestId,source.request.requestId);
   const oldRun=await actualRun(old);assert.equal(oldRun.status,'PASSED');
   const oldArchive=await old.client.artifact(actor(),old.request,old.runId,AbortSignal.timeout(60000));
   const oldVerified=await artifactApi.verifyCiArtifact(oldArchive,old.request,old.retained.request.plan.parameters.expectedChecks,AbortSignal.timeout(30000));
   const currentCandidate=source.request.candidateInput?.manifest??verified.candidate;assert(currentCandidate);assert.equal(oldVerified.status,'PASSED');assert(oldVerified.candidate);
   assert.notEqual(instanceApi.candidateDigest(oldVerified.candidate),instanceApi.candidateDigest(currentCandidate),'Two request labels for the same manifest do not establish an old-candidate mismatch');
   const oldName='actual-ci-archive-'+(++archiveSequence)+'.zip';fs.writeFileSync(path.join(run.selection.outputRoot,oldName),oldArchive.bytes,{mode:0o600,flag:'wx'});
   run.artifact('actual-old-candidate.json',{file:oldName,archiveDigest:oldArchive.archiveDigest,archiveBytes:oldArchive.archiveBytes,verified:oldVerified,currentCandidate});
   await rejection('distinct authentic old-candidate artifact reused for current request',()=>artifactApi.verifyCiArtifact(oldArchive,source.request,verified.checks.map(v=>v.id),AbortSignal.timeout(15000)),['CI_ARTIFACT_MISMATCH']);
   const rerun=await providerOriginal(provider,plan.rerun);assert.notEqual(rerun.request.requestId,source.request.requestId,'Use a separately retained real rerun fixture');
   if(provider==='github')assert(rerun.raw.run_attempt>1,'A caller-supplied attempt label is not a real rerun');
   else{
    const jobs=await rerun.transport.get(actor(),'/pipelines/'+rerun.runId+'/jobs?include_retried=true&per_page=100',AbortSignal.timeout(15000));
    run.artifact('actual-gitlab-retried-jobs.json',{runId:rerun.runId,jobs});assert(Array.isArray(jobs)&&jobs.length<100);
    assert(new Set(jobs.map(j=>JSON.stringify([j.stage,j.name]))).size<jobs.length,'GitLab must contain actual retained retried jobs');
   }
   await rejection('real provider rerun cannot reuse the original attempt',()=>actualRun(rerun),['CI_RUN_MISMATCH']);
   const skipped=await providerOriginal(provider,plan.skipped),skippedRun=await actualRun(skipped);
   assert.equal(skippedRun.status,'FAILED');assert(skippedRun.jobs.some(j=>j.providerStatus==='skipped'||j.providerStatus==='completed:skipped'));
   assert.notEqual(skipped.retained.instance.stages[skipped.retained.request.stageId].status,'PASSED','Runtime must not have accepted a skipped mandatory job');
   const forkCredential=await forkCredentialLoss(provider,plan.forkCredential);const release=await releaseMismatch(plan.release,provider),publication=await publicationInspection(plan.publication,provider,c);
   const covered={provider,realPlatformReads:true,archiveVerified:true,wrongCommit:true,wrongAttempt:true,skippedJob:true,reportProvenance:true,reportDigest:true,distinctOldCandidate:true,release,publication,forkCredential,remaining:[]};
   run.artifact('provider-mismatch-covered-branches.json',covered);
   return covered;
  }
  function requireCompleteProvider(covered){
   assert.deepEqual(covered.remaining,[],'E18_PROVIDER_PRECONDITION_REQUIRED: retain a real fork-CI credential-loss result; covered negative branches are not the whole fixed provider journey');
   return covered;
  }
  const predicateClaims=new Set();
  for(const c of run.cases)await run.collect(c,async()=>{
   if(c.caseInstanceId==='E18.CV07')return collectCoverageInventory(run,c);
   const plan=fixture.casePlans[c.caseInstanceId];
   if(c.kind==='STAGE_ADMISSION'){
    assert(plan,'Missing original native precondition for '+c.caseInstanceId);
    if(c.parameters.stage==='scope'&&c.parameters.predecessorOutcome!=='passed')return scopePrerequisite(c,plan);
    const claim=JSON.stringify([plan.instanceId,plan.predecessorId,c.parameters.predecessorOutcome]);
    assert(!predicateClaims.has(claim),'Do not count one native precondition repeatedly under different fixed provider/stage labels');predicateClaims.add(claim);
    return stageAdmission(c,plan);
   }
   if(c.caseInstanceId==='E18.journey'){
    assert(plan);keys(plan,['providers']);assert.deepEqual(plan.providers.map(p=>p.provider).sort(),['github','gitlab']);
    const observed=[];for(const provider of plan.providers)observed.push(await providerMismatches(c,provider));
    return{providers:observed.map(requireCompleteProvider)};
   }
   if(['E18.variant.01','E18.variant.02'].includes(c.caseInstanceId)){assert(plan);return requireCompleteProvider(await providerMismatches(c,plan));}
   const requirements=c.parameters.variantContract;assert(requirements);
   run.artifact('unfulfilled-fixed-contract.json',{caseInstanceId:c.caseInstanceId,contract:requirements,denominatorRetained:true,sourceTestsCredited:false,releaseAuthorized:false});
   if(c.caseInstanceId==='E18.CV03')return collectManagedBudget(run,c);
   assert.fail('Unimplemented fixed E18 case '+c.caseInstanceId);
  });
 }finally{run.finish();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))test('E18 installed CI evidence and exact release-authority mismatch',executeE18);

// Fixed source-audited branches; no fixture or provider action runs at registration.
const E18_CALLABLE_ROUTES=Object.freeze({"E18.journey":{"handler":"providerMismatches/two-providers"},"E18.variant.01":{"handler":"providerMismatches/github"},"E18.variant.02":{"handler":"providerMismatches/gitlab"},"E18.CV03":{"handler":"collectManagedBudget"},"E18.CV07":{"handler":"collectCoverageInventory"},"E18.stage.github.scope.not-run":{"handler":"scopePrerequisite"},"E18.stage.github.scope.failed":{"handler":"scopePrerequisite"},"E18.stage.github.scope.unknown":{"handler":"scopePrerequisite"},"E18.stage.github.scope.missing-evidence":{"handler":"scopePrerequisite"},"E18.stage.github.scope.passed":{"handler":"stageAdmission"},"E18.stage.github.plan.not-run":{"handler":"stageAdmission"},"E18.stage.github.plan.failed":{"handler":"stageAdmission"},"E18.stage.github.plan.unknown":{"handler":"stageAdmission"},"E18.stage.github.plan.missing-evidence":{"handler":"stageAdmission"},"E18.stage.github.plan.passed":{"handler":"stageAdmission"},"E18.stage.github.implementation.not-run":{"handler":"stageAdmission"},"E18.stage.github.implementation.failed":{"handler":"stageAdmission"},"E18.stage.github.implementation.unknown":{"handler":"stageAdmission"},"E18.stage.github.implementation.missing-evidence":{"handler":"stageAdmission"},"E18.stage.github.implementation.passed":{"handler":"stageAdmission"},"E18.stage.github.candidate.not-run":{"handler":"stageAdmission"},"E18.stage.github.candidate.failed":{"handler":"stageAdmission"},"E18.stage.github.candidate.unknown":{"handler":"stageAdmission"},"E18.stage.github.candidate.missing-evidence":{"handler":"stageAdmission"},"E18.stage.github.candidate.passed":{"handler":"stageAdmission"},"E18.stage.github.verification.not-run":{"handler":"stageAdmission"},"E18.stage.github.verification.failed":{"handler":"stageAdmission"},"E18.stage.github.verification.unknown":{"handler":"stageAdmission"},"E18.stage.github.verification.missing-evidence":{"handler":"stageAdmission"},"E18.stage.github.verification.passed":{"handler":"stageAdmission"},"E18.stage.github.release-decision.not-run":{"handler":"stageAdmission"},"E18.stage.github.release-decision.failed":{"handler":"stageAdmission"},"E18.stage.github.release-decision.unknown":{"handler":"stageAdmission"},"E18.stage.github.release-decision.missing-evidence":{"handler":"stageAdmission"},"E18.stage.github.release-decision.passed":{"handler":"stageAdmission"},"E18.stage.github.publication.not-run":{"handler":"stageAdmission"},"E18.stage.github.publication.failed":{"handler":"stageAdmission"},"E18.stage.github.publication.unknown":{"handler":"stageAdmission"},"E18.stage.github.publication.missing-evidence":{"handler":"stageAdmission"},"E18.stage.github.publication.passed":{"handler":"stageAdmission"},"E18.stage.github.closure.not-run":{"handler":"stageAdmission"},"E18.stage.github.closure.failed":{"handler":"stageAdmission"},"E18.stage.github.closure.unknown":{"handler":"stageAdmission"},"E18.stage.github.closure.missing-evidence":{"handler":"stageAdmission"},"E18.stage.github.closure.passed":{"handler":"stageAdmission"},"E18.stage.gitlab.scope.not-run":{"handler":"scopePrerequisite"},"E18.stage.gitlab.scope.failed":{"handler":"scopePrerequisite"},"E18.stage.gitlab.scope.unknown":{"handler":"scopePrerequisite"},"E18.stage.gitlab.scope.missing-evidence":{"handler":"scopePrerequisite"},"E18.stage.gitlab.scope.passed":{"handler":"stageAdmission"},"E18.stage.gitlab.plan.not-run":{"handler":"stageAdmission"},"E18.stage.gitlab.plan.failed":{"handler":"stageAdmission"},"E18.stage.gitlab.plan.unknown":{"handler":"stageAdmission"},"E18.stage.gitlab.plan.missing-evidence":{"handler":"stageAdmission"},"E18.stage.gitlab.plan.passed":{"handler":"stageAdmission"},"E18.stage.gitlab.implementation.not-run":{"handler":"stageAdmission"},"E18.stage.gitlab.implementation.failed":{"handler":"stageAdmission"},"E18.stage.gitlab.implementation.unknown":{"handler":"stageAdmission"},"E18.stage.gitlab.implementation.missing-evidence":{"handler":"stageAdmission"},"E18.stage.gitlab.implementation.passed":{"handler":"stageAdmission"},"E18.stage.gitlab.candidate.not-run":{"handler":"stageAdmission"},"E18.stage.gitlab.candidate.failed":{"handler":"stageAdmission"},"E18.stage.gitlab.candidate.unknown":{"handler":"stageAdmission"},"E18.stage.gitlab.candidate.missing-evidence":{"handler":"stageAdmission"},"E18.stage.gitlab.candidate.passed":{"handler":"stageAdmission"},"E18.stage.gitlab.verification.not-run":{"handler":"stageAdmission"},"E18.stage.gitlab.verification.failed":{"handler":"stageAdmission"},"E18.stage.gitlab.verification.unknown":{"handler":"stageAdmission"},"E18.stage.gitlab.verification.missing-evidence":{"handler":"stageAdmission"},"E18.stage.gitlab.verification.passed":{"handler":"stageAdmission"},"E18.stage.gitlab.release-decision.not-run":{"handler":"stageAdmission"},"E18.stage.gitlab.release-decision.failed":{"handler":"stageAdmission"},"E18.stage.gitlab.release-decision.unknown":{"handler":"stageAdmission"},"E18.stage.gitlab.release-decision.missing-evidence":{"handler":"stageAdmission"},"E18.stage.gitlab.release-decision.passed":{"handler":"stageAdmission"},"E18.stage.gitlab.publication.not-run":{"handler":"stageAdmission"},"E18.stage.gitlab.publication.failed":{"handler":"stageAdmission"},"E18.stage.gitlab.publication.unknown":{"handler":"stageAdmission"},"E18.stage.gitlab.publication.missing-evidence":{"handler":"stageAdmission"},"E18.stage.gitlab.publication.passed":{"handler":"stageAdmission"},"E18.stage.gitlab.closure.not-run":{"handler":"stageAdmission"},"E18.stage.gitlab.closure.failed":{"handler":"stageAdmission"},"E18.stage.gitlab.closure.unknown":{"handler":"stageAdmission"},"E18.stage.gitlab.closure.missing-evidence":{"handler":"stageAdmission"},"E18.stage.gitlab.closure.passed":{"handler":"stageAdmission"}});
export function registerE18CallableCases(catalog){
 const routes=E18_CALLABLE_ROUTES;
 return registerFixedScenario({scenario:'E18',phase:'PRE_RELEASE',catalog,routes,execute:executeE18});
}
