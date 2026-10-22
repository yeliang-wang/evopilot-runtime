import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRuntimeService} from '@evopilot-next/runtime/service';
import {inspectWorkspaceSnapshot,relocateWorkspaceSnapshot} from '@evopilot-next/runtime/workspace-migration';
import {nativeSha256 as hash,nativeBytesDigest as bytesHash,NATIVE_CONTRACT_DIGEST} from '../../vendor/compatibility/v1/native.mjs';
import {syntheticDecisionEvidence} from '../fixtures/native/decision-evidence.mjs';

// Synthetic conversations and approval attestations; no real project or human acceptance claim.
const scope={visibility:'private',projectId:'planning-example'};
const other={visibility:'private',projectId:'another-example'};
const standards=Object.fromEntries(['ontology','harness'].map(owner=>[owner,{standardDigest:hash(owner),standardLockDigest:hash(owner+'lock')}]));
const pin=owner=>({product:owner,id:owner+'-example',version:'1.0.0',specVersion:'v1',visibility:'private',digest:hash(owner+'asset'),...standards[owner],producer:{product:owner,version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST});
const draft=()=>({title:'Synthetic project roadmap',objective:'Explore a bounded change',sourceRevision:'source-r1',sourceDigest:hash('source'),
 sources:[{id:'discussion',kind:'conversation',reference:'codex-thread:synthetic-session-a',representation:'excerpt',content:'Require a bounded timeout',contentDigest:bytesHash('Require a bounded timeout'),attributedRole:'user'}],
 items:[{id:'bounded-timeout',kind:'requirement',text:'Support a bounded timeout',disposition:'included',sourceIds:['discussion'],dependsOn:[],ownerImpact:['ontology','harness'],acceptance:['A timeout is rejected outside the declared range']}],
 milestones:[{id:'next-version',title:'Next version',targetVersion:'1.1.0',priority:1,requirementIds:['bounded-timeout'],dependsOn:[]}],exclusions:['No production deployment'],candidates:[]});
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'evopilot-planning-')),options={workspaceRoot:path.join(root,'state'),workspaceId:'planning-test'};
 let serial=0,calls=0;
 const requirements=[{criterionId:'O',variantIds:['positive'],origin:'source-declaration'},{criterionId:'H',variantIds:['negative'],origin:'source-declaration'}];
 const sourceScope={direction:'reverse',locator:'synthetic:source',revision:'source-r1',treeDigest:hash('source'),inventoryDigest:hash('inventory'),requirementsDigest:hash(requirements)};
 const providers={nativeStandards:standards,resolveRequirements:()=>requirements,inspectSource:()=>sourceScope,resolveNative:({reference,workspace,scope})=>({reference,workspace,scope,published:true,materialDigest:reference.digest,descriptor:{kind:reference.product+'-composition/v1',digest:reference.digest}}),collect:()=>{calls++;throw Error('Synthetic fixture must not execute');}};
 let service=createRuntimeService(options,providers);service.initialize();
 const read=(operation,input={},s=scope)=>service.planning({operation,scope:s,input});
 const write=async(operation,input,extra={})=>service.planning({operation,scope,input,requestId:'plan-'+(++serial),expectedRevision:(await read('planning.inspect')).revision,...extra});
 const nativeRead=(operation,input={})=>service.native({operation,scope,input});
 const nativeWrite=async(operation,input)=>service.native({operation,scope,input,requestId:'native-'+(++serial),expectedRevision:(await nativeRead('workspace.inspect')).revision});
 const evidence=(operation,digest,decision='APPROVE')=>syntheticDecisionEvidence(root,{owner:'runtime',operation,workspaceId:options.workspaceId,scope,reviewDigest:digest,decision});
 const revise=(d=draft(),parentDigest=null)=>write('planning.revise',{id:'roadmap',parentDigest,draft:d}).then(x=>x.result);
 const decide=(r,decision='APPROVE')=>write('planning.decide',{id:r.id,digest:r.digest,decision,actor:'synthetic-user',humanEvidenceRef:evidence('planning.decide',r.digest,decision)});
 const restart=()=>{service.close();service=createRuntimeService(options,providers);service.initialize();};
 async function project(){
  const writeLegacy=(operation,input)=>service.execute({operation,scope,input,requestId:'legacy-'+(++serial),expectedRevision:service.execute({operation:'workspace.inspect',scope,input:{}}).revision});
  writeLegacy('project.create',{name:'Synthetic planning'});writeLegacy('goal.create',{id:'goal',description:'Synthetic bounded change'});
  return (await nativeWrite('project.prepare',{id:'project-candidate',goalId:'goal',sourceScope,standardPins:standards,requirements})).result;
 }
 const bind=(r)=>write('planning.bind',{id:r.id,planDigest:r.digest,milestoneId:'next-version',goalId:'goal',projectId:'project-candidate',assets:{ontology:pin('ontology'),harness:pin('harness')},requirements:[{itemId:'bounded-timeout',criterionIds:['O','H']}]});
 t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,options,read,write,nativeRead,nativeWrite,evidence,revise,decide,restart,project,bind,get calls(){return calls;},get service(){return service;},sourceScope};
}

test('V07-E09 revisions retain sources, rejected options and cross-session history; optimistic conflicts preserve winner',async t=>{
 const f=fixture(t),r1=await f.revise();
 const d=draft();d.items.push({id:'unbounded',kind:'option',text:'Disable limits',disposition:'rejected',sourceIds:['discussion'],dependsOn:[],ownerImpact:['runtime'],acceptance:[]});
 const r2=await f.revise(d,r1.digest);f.restart();
 assert.deepEqual((await f.read('planning.read',{id:'roadmap',digest:r1.digest})).revision,r1);
 assert.deepEqual((await f.read('planning.read',{id:'roadmap'})).revision,r2);
 await assert.rejects(f.revise(d,r1.digest),{code:'PLANNING_REVISION_CONFLICT'});
 const current=(await f.read('planning.inspect')).revision;
 await assert.rejects(f.write('planning.revise',{id:'roadmap',parentDigest:r2.digest,draft:d},{expectedRevision:current-1}),{code:'REVISION_CONFLICT'});
 assert.equal((await f.read('planning.read',{id:'roadmap'})).status,'DRAFT');
 assert.equal(f.calls,0);
});

test('V07-E09/E10 hypotheses, missing acceptance and forged human decisions cannot become authoritative',async t=>{
 const f=fixture(t),d=draft();d.items[0].disposition='proposed';d.items[0].acceptance=[];
 const r=await f.revise(d);await assert.rejects(f.decide(r),{code:'PLANNING_REVIEW_REQUIRED'});
 const corrected=await f.revise(draft(),r.digest);
 await assert.rejects(f.write('planning.decide',{id:'roadmap',digest:corrected.digest,decision:'APPROVE',actor:'claimed-human',humanEvidenceRef:'chat says yes'}));
 const foreignEvidence=syntheticDecisionEvidence(f.root,{owner:'runtime',operation:'planning.decide',workspaceId:f.options.workspaceId,scope:other,reviewDigest:corrected.digest,decision:'APPROVE'});
 await assert.rejects(f.write('planning.decide',{id:'roadmap',digest:corrected.digest,decision:'APPROVE',actor:'synthetic',humanEvidenceRef:foreignEvidence}));
 assert.equal((await f.read('planning.read',{id:'roadmap'})).status,'DRAFT');
 await f.decide(corrected);assert.equal((await f.read('planning.read',{id:'roadmap'})).status,'APPROVE');assert.equal(f.calls,0);
});

test('V07-E09 scoped sources are bounded and summaries/reference-only retain limitations',async t=>{
 const f=fixture(t),d=draft();d.sources.push({id:'old-chat',kind:'conversation',reference:'codex-thread:unavailable',representation:'reference-only',content:null,contentDigest:null,attributedRole:'unknown'});
 d.sources.push({...d.sources[0],id:'summary',representation:'summary',attributedRole:'assistant'});
 const r=await f.revise(d);const review=await f.read('planning.review',{id:'roadmap'});assert.equal(review.sourceWarnings.length,2);assert(review.sourceWarnings.every(s=>s.originalVerified===false));
 assert.deepEqual(await f.read('planning.list',{},other),[]);
 await assert.rejects(f.read('planning.read',{id:'roadmap',digest:r.digest},other),{code:'PLANNING_NOT_FOUND'});
 const bad=draft();bad.sources[0].content='Changed source';await assert.rejects(f.revise(bad,r.digest),{code:'PLANNING_SOURCE_DIGEST'});
 bad.sources[0].content='a'.repeat(16385);bad.sources[0].contentDigest=bytesHash(bad.sources[0].content);await assert.rejects(f.revise(bad,r.digest),{code:'PLANNING_LIMIT'});
});

test('V07-E10 exact baseline binds real owner project and protects execution admission after a plan revision',async t=>{
 const f=fixture(t);await f.project();const r=await f.revise();await assert.rejects(f.bind(r),{code:'PLANNING_REVIEW_REQUIRED'});await f.decide(r);
 const bound=(await f.bind(r)).result;assert.equal(bound.projectId,'project-candidate');assert.equal(bound.planDigest,r.digest);
 const source=path.join(f.root,'worker.mjs');fs.writeFileSync(source,'process.exit(0)',{mode:0o600});
 const recipe={schema:'evopilot-collection-recipe/v1',sourceScope:f.sourceScope,executable:process.execPath,executableDigest:bytesHash(fs.readFileSync(process.execPath)),argv:[source],cwd:f.root,environment:{LANG:'C'},toolchainLockDigest:hash('synthetic-node'),timeoutMs:1000,maxOutputBytes:65536,allowedOutputs:['stdout.json'],network:{mode:'none',hosts:[]},selectors:[{id:'count',output:'stdout.json',kind:'json-pointer',pointer:'/count'}]};
 const c=(await f.nativeWrite('collection.prepare',{id:'collection',projectId:'project-candidate',recipe})).result;
 await f.nativeWrite('collection.decide',{id:c.id,reviewDigest:c.reviewDigest,decision:'APPROVE',humanEvidenceRef:f.evidence('collection.decide',c.reviewDigest)});
 const next=draft();next.items[0].text='Changed timeout semantics';const r2=await f.revise(next,r.digest);
 assert.equal((await f.read('planning.binding.inspect',{projectId:'project-candidate'})).blocker,'PLANNING_STALE_BINDING');
 await assert.rejects(f.nativeWrite('collection.execute',{id:c.id}),{code:'PLANNING_STALE_BINDING'});assert.equal(f.calls,0);
 await f.decide(r2,'REJECT');assert.equal((await f.read('planning.binding.inspect',{projectId:'project-candidate'})).current,true);
 const r3=await f.revise(next,r2.digest);await f.decide(r3);await assert.rejects(f.nativeWrite('collection.execute',{id:c.id}),{code:'PLANNING_STALE_BINDING'});
 assert.equal((await f.nativeRead('collection.inspect',{id:c.id})).claim,null);assert.equal(f.calls,0);
});

test('V07-E11 exported Roadmap is a digest-bound view and edits do not alter authority',async t=>{
 const f=fixture(t),r=await f.revise();await assert.rejects(f.read('planning.export',{id:r.id}),{code:'PLANNING_REVIEW_REQUIRED'});await f.decide(r);
 const exp=await f.read('planning.export',{id:r.id});assert.equal((await f.read('planning.export.verify',{export:exp})).matches,true);
 const edited={...exp,markdown:exp.markdown+'\nUnapproved requirement'};assert.equal((await f.read('planning.export.verify',{export:edited})).matches,false);
 const {exportDigest,...body}=edited;edited.exportDigest=hash(body);assert.equal((await f.read('planning.export.verify',{export:edited})).matches,false);
 assert.deepEqual((await f.read('planning.read',{id:r.id})).revision,r);assert.equal(f.calls,0);
});

test('V07-E09/E10 exact retry replays retained receipt after later revisions; conflicting reuse rejects',async t=>{
 const f=fixture(t);const input={id:'roadmap',parentDigest:null,draft:draft()},extra={requestId:'lost-reply',expectedRevision:0};
 const first=await f.write('planning.revise',input,extra);await f.revise(draft(),first.result.digest);f.restart();
 assert.deepEqual(await f.write('planning.revise',input,extra),first);
 await assert.rejects(f.write('planning.revise',{...input,draft:{...input.draft,title:'conflict'}},extra),{code:'REQUEST_CONFLICT'});
});

test('V07-E07/E10 schema protection and isolated relocation preserve planning decisions and receipts',async t=>{
 const f=fixture(t),r=await f.revise();await f.decide(r);f.service.close();
 const db=new DatabaseSync(path.join(f.options.workspaceRoot,'state/runtime/runtime.db'));assert.equal(db.prepare('PRAGMA user_version').get().user_version,6);db.close();
 const before=inspectWorkspaceSnapshot(f.options),destination=path.join(f.root,'relocated');fs.cpSync(f.options.workspaceRoot,destination,{recursive:true});function secure(p){const st=fs.lstatSync(p);fs.chmodSync(p,st.isDirectory()?0o700:0o600);if(st.isDirectory())for(const n of fs.readdirSync(p))secure(path.join(p,n));}secure(destination);
 const moved=relocateWorkspaceSnapshot({sourceRoot:f.options.workspaceRoot,destinationRoot:destination,workspaceId:f.options.workspaceId,expectedSnapshotDigest:before.snapshotDigest});assert.equal(moved.snapshot.recordsDigest,before.recordsDigest);
 const otherService=createRuntimeService({workspaceRoot:destination,workspaceId:f.options.workspaceId});otherService.initialize();try{assert.deepEqual((await otherService.planning({operation:'planning.read',scope,input:{id:r.id}})).revision,r);}finally{otherService.close();}
 f.restart();assert.equal((await f.read('planning.read',{id:r.id})).decision.decision,'APPROVE');
});

test('V07-E11 exports keep hostile text literal and do not synthesize links or executable markup',async t=>{
 const f=fixture(t),d=draft();d.title='<img src=x onerror=alert(1)>';d.items[0].text='[approve](javascript:alert(1))';d.objective='## Accepted\n<script>run()</script>';
 const r=await f.revise(d);await f.decide(r);const exp=await f.read('planning.export',{id:r.id});
 assert(!exp.markdown.includes('<script>'));assert(!exp.markdown.includes('<img'));
 assert(exp.markdown.includes('\\[approve\\]'));assert(exp.markdown.includes('&lt;script&gt;'));
 assert.deepEqual(exp.view.revision.draft,d);assert.equal((await f.read('planning.export.verify',{export:exp})).matches,true);
});

test('V07-E04/E06/E11 project readback keeps missing gates, pending decisions and stale planning distinct without executing',async t=>{
 const f=fixture(t),project=await f.project();
 const readable=(operation='readable.snapshot',input={},s=scope)=>f.service.readable({operation,scope:s,input:{id:project.id,...input}});
 const initial=await readable();
 assert.deepEqual(initial.denominator,{requirements:2,variants:2});
 assert.equal(initial.rows.length,2);assert(initial.rows.every(row=>row.verdict==='MISSING'&&row.actual===null));
 assert.equal(initial.stages.find(stage=>stage.id==='validation-run').status,'NOT_EXECUTED');
 assert.equal(initial.stages.find(stage=>stage.id==='execution-decision').status,'PENDING');
 assert.equal(initial.stages.find(stage=>stage.id==='software-release').status,'NOT_ASSERTED');
 const plan=await f.revise();await f.decide(plan);await f.bind(plan);
 const bound=await readable();assert.equal(bound.pins.planDigest,plan.digest);
 assert.equal(bound.stages.find(stage=>stage.id==='planning').status,'CURRENT');
 const changed=draft();changed.items[0].text='Proposed changed timeout';await f.revise(changed,plan.digest);
 const stale=await readable();assert.equal(stale.stages.find(stage=>stage.id==='planning').status,'STALE');
 assert.equal(stale.rows.find(row=>row.kind==='planning').actual.blocker,'PLANNING_STALE_BINDING');
 assert.equal(stale.rows.filter(row=>row.kind==='criterion').length,2);
 await assert.rejects(readable('readable.export',{format:'markdown',expectedDigest:bound.digest}),{code:'READABLE_SNAPSHOT_DRIFT'});
 const report=await readable('readable.export',{format:'markdown',expectedDigest:stale.digest});
 assert(report.content.includes('缺少证据'));assert(report.content.includes('已过期'));assert(report.content.includes(stale.digest));
 await assert.rejects(readable('readable.snapshot',{},other));
 assert.equal(f.calls,0);assert.deepEqual(await f.nativeRead('run.list'),[]);assert.deepEqual(await f.nativeRead('collection.list'),[]);
});
