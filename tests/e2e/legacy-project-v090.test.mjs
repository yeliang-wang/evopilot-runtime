import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,symlinkSync,mkdirSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {projectFixture,put,rehash} from '../fixtures/legacy-project-v090.mjs';
import {nativePackageDigest,nativeSha256 as hash,nativeBytesDigest} from '../../vendor/compatibility/v1/native.mjs';
import {createProjectHostRoutes,PROJECT_CALLS} from '../../dist/host/project/routes.js';
import {inspectProjectStandard} from '../../dist/host/project/native-project.js';
import {createLegacyTools} from '../../dist/host/legacy-tools.js';
import {preparePromotion,finishPromotion} from '../../dist/host/project/native-promotion.js';

for(const level of ['L1','L2','L3'])test(`project preparation retains explicit ${level} target without issuing an asset grade or reconstruction`,async()=>{
 const f=projectFixture({level});try{const candidate=await f.service.prepare(f.input);assert.equal(candidate.modelingIntent.definition.targetLevel,level);assert.equal(candidate.authority,false);assert(!Object.hasOwn(candidate,'verifiedLevel'));assert(!Object.hasOwn(candidate.modelingIntent.definition,'reconstruction'));assert.equal(f.control.validationCalls,0);}finally{f.cleanup();}
});

for(const direction of ['forward','reverse'])for(const visibility of ['private','public'])test(`${direction}/${visibility} retained preparation preserves v2 L3 intent, source and exact asset admission`,async()=>{
 const f=projectFixture({direction,visibility});try{
  const frozen=await f.freeze(),material=await f.service.materialize({scope:f.scope,id:f.input.id,packages:f.packages});assert.equal(frozen.candidate.modelingIntent.definition.targetLevel,'L3');assert.equal(frozen.candidate.modelingIntent.definition.schema,'evopilot-modeling-intent/v2');assert.equal(f.service.checkLayout({scope:f.scope,id:f.input.id}).conforms,true);
  assert.equal(frozen.candidate.nativeRequirements.length,8,'five project obligations, two independently fixed owner scopes and one domain decision');
  for(const owner of ['ontology','harness']){
   const pkg=f.packages[owner],bindings=JSON.parse(pkg.files[pkg.manifest.sourceBindingRef]),request={workspaceId:f.workspaceId,scope:f.scope,owner,packageDigest:nativePackageDigest(pkg),sourceBindingsDigest:hash(bindings),sourceDirection:direction};
   const admission=f.service.resolveNativeAuthoring(request);assert.equal(admission.authority,false);assert.equal(admission.candidateDigest,frozen.candidate.reviewDigest);
   const intent=f.service.resolveReadinessAuthoring({workspaceId:f.workspaceId,scope:f.scope,owner,packageDigest:request.packageDigest,intentDigest:hash(f.input.modelingIntent.definition)});assert.deepEqual(intent.definition,f.input.modelingIntent.definition);assert.equal(intent.authority,false);
   assert.throws(()=>f.service.resolveNativeAuthoring({...request,sourceBindingsDigest:hash('substitution')}),{code:'AUTHORING_CONTEXT_STALE'});
  }
  assert.equal(material.candidateDigest,frozen.candidate.reviewDigest);const file=join(f.service.candidateLocation({scope:f.scope,id:f.input.id}),'ontology',f.packages.ontology.manifest.id,'model.ttl');writeFileSync(file,'changed');assert.throws(()=>f.service.checkLayout({scope:f.scope,id:f.input.id}),{code:'PROJECT_ASSET_DRIFT'});
 }finally{f.cleanup();}
});
test('source inventory, independent coverage and exact freeze decision cannot be replaced by generated claims',async()=>{
 const f=projectFixture();try{
  await assert.rejects(()=>f.service.prepare({...f.input,requirements:{...f.input.requirements,modules:[]}}),{code:'PROJECT_MODULE_COVERAGE'});
  const c=await f.service.prepare(f.input);await assert.rejects(()=>f.service.freeze({scope:f.scope,id:f.input.id,packages:f.packages,reviewDigest:c.reviewDigest,humanEvidenceRef:'unreviewed'}),{code:'HUMAN_EVIDENCE_REQUIRED'});
  assert(!existsSync(join(f.stateRoot,'state/project-standards/private/synthetic/frozen',f.input.id+'.json')));
  const changed=structuredClone(f.packages),b=JSON.parse(changed.harness.files['source-bindings.json']);b.mappings[0].fragmentDigest=hash('different');changed.harness.files['source-bindings.json']=JSON.stringify(b);rehash(changed.harness);
  await assert.rejects(()=>f.service.preflight({project:f.input,packages:changed}),{code:'PROJECT_FRAGMENT_DRIFT'});
  await f.freeze();put(join(f.source,'new.txt'),'new material');assert.throws(()=>f.service.inspectSource({scope:f.scope,sourceScope:c.sourceScope}),{code:'REVIEW_REQUIRED'});
 }finally{f.cleanup();}
});
test('reverse modeling cannot bypass explicit purpose/level; changed v2 intent and failed native preflight block freezing',async()=>{
 const f=projectFixture({direction:'reverse'});try{
  const{modelingIntent,...missing}=f.input;await assert.rejects(()=>f.service.prepare(missing),{code:'MODELING_INTENT_REQUIRED'});
  await assert.rejects(()=>f.service.prepare({...f.input,modelingIntent:{...modelingIntent,definition:{...modelingIntent.definition,targetLevel:'L1'}}}));
  const c=await f.service.prepare(f.input);f.control.valid=false;await assert.rejects(()=>f.service.freeze({scope:f.scope,id:f.input.id,packages:f.packages,reviewDigest:c.reviewDigest,humanEvidenceRef:f.decision('freeze',c.reviewDigest)}),{code:'PROJECT_ONTOLOGY_PREFLIGHT'});
 }finally{f.cleanup();}
});
test('revocation during owner preflight prevents materialization and exact reviewed retries preserve prior bytes',async()=>{
 const f=projectFixture();try{
  const frozen=await f.freeze(),current=join(f.projectRoot,'private/projects/synthetic');put(join(current,'custom.txt'),'original customization');
  f.control.afterValidation=()=>{f.control.active=false;};await assert.rejects(()=>f.service.materialize({scope:f.scope,id:f.input.id,packages:f.packages}),{code:'OWNER_HOST_CHANGED'});
  assert(!existsSync(join(f.stateRoot,'state/project-standards/private/synthetic/materials',f.input.id+'.json')));assert.equal(readFileSync(join(current,'custom.txt'),'utf8'),'original customization');
  f.control.active=true;f.control.afterValidation=null;const material=await f.service.materialize({scope:f.scope,id:f.input.id,packages:f.packages});assert.deepEqual(await f.service.materialize({scope:f.scope,id:f.input.id,packages:f.packages}),material);
  const changed=structuredClone(f.packages);changed.ontology.files['model.ttl']+='new';rehash(changed.ontology);await assert.rejects(()=>f.service.materialize({scope:f.scope,id:f.input.id,packages:changed}),{code:'PROJECT_CONFLICT'});assert.equal(f.service.inspect({scope:f.scope,id:f.input.id}).candidate.reviewDigest,frozen.candidate.reviewDigest);
 }finally{f.cleanup();}
});
test('domain review and protected Runtime completion precede promotion while custom and historical bytes survive',async()=>{
 const f=projectFixture();try{
  const frozen=await f.freeze(),material=await f.service.materialize({scope:f.scope,id:f.input.id,packages:f.packages}),current=join(f.projectRoot,'private/projects/synthetic');put(join(current,'custom.txt'),'custom bytes');put(join(current,'README.md'),'historical navigation');
  const project={id:'runtime-project',scope:f.scope,sourceScope:frozen.candidate.sourceScope,requirements:frozen.candidate.nativeRequirements,standardPins:frozen.candidate.standardPins,candidateDigest:hash('synthetic-runtime-project')},assetDigests=Object.fromEntries(Object.entries(f.packages).map(([o,p])=>[o,nativePackageDigest(p)])),run={claim:{context:{synthetic:true}},reviewDigest:hash('synthetic-run'),plan:{pins:Object.fromEntries(Object.entries(assetDigests).map(([o,digest])=>[o,{digest}]))}};
  assert.equal(f.service.verifyProject({project,run}).criteria.find(r=>r.criterionId.startsWith('domain:')).status,'UNKNOWN');await assert.rejects(()=>f.service.promote({scope:f.scope,id:f.input.id,runtimeProjectId:project.id}),{code:'PROJECT_COMPLETION_REQUIRED'});
  const bindings=f.service.checkLayout({scope:f.scope,id:f.input.id}).bindings,subject={candidateDigest:frozen.candidate.reviewDigest,runtimeCandidateDigest:project.candidateDigest,assetDigests,bindingsDigest:material.bindingsDigest,inferredMappings:bindings.inferred};
  await f.service.reviewDomain({scope:f.scope,id:f.input.id,...Object.fromEntries(Object.entries(subject).filter(([k])=>k!=='candidateDigest')),decision:'ACCEPT',humanEvidenceRef:f.decision('reviewDomain',hash(subject))});
  const check=f.service.verifyProject({project,run});assert(check.criteria.every(r=>r.status==='PASS'));
  f.control.completed={...project,complete:{runId:'synthetic-run',runDigest:hash('synthetic-completion'),projectCheck:check,decision:{decision:'APPROVE'},at:'synthetic-time'}};
  const receipt=await f.service.promote({scope:f.scope,id:f.input.id,runtimeProjectId:project.id});assert.equal(receipt.completed,true);assert.equal(readFileSync(join(receipt.previous,'README.md'),'utf8'),'historical navigation');assert.equal(readFileSync(join(receipt.current,'custom.txt'),'utf8'),'custom bytes');assert.deepEqual(await f.service.promote({scope:f.scope,id:f.input.id,runtimeProjectId:project.id}),receipt);
 }finally{f.cleanup();}
});
test('Host project helper exact allowlist and original ledger do not grant native completion or fresh operational evidence',async()=>{
 const f=projectFixture();try{
  const selection={root:f.projectRoot,calls:[...PROJECT_CALLS]},routes=createProjectHostRoutes(f.context,f.scope.projectId,selection,f.trusted,()=>{});
  const baseline=await routes.workspace('bind',{projectId:'synthetic',sourceRoot:f.source,files:['ontology.txt','harness.txt','package.json']},'baseline');
  const input={projectId:'synthetic',id:'target',goal:'Retained synthetic goal',sourceDigest:baseline.record.baseline.digest,criteria:[{id:'check',status:'PENDING',evidence:[]}],loops:[{id:'loop',observation:'Observed fixture',action:'Prepare later',result:'Still pending'}],status:'IN_PROGRESS'};
  const written=await routes.workspace('campaign.write',input,'first');assert.equal(written.authority,false);assert.deepEqual(await routes.workspace('campaign.write',input,'first'),written);
  const relative='private/projects/synthetic/targets/target/first.json',bytes=readFileSync(join(f.projectRoot,relative)),ref={owner:'workspace',id:relative,digest:nativeBytesDigest(bytes)};
  const evidence=routes.readWorkspaceEvidence({scope:f.scope,reference:ref});assert.equal(evidence.observedAt,1);assert.equal(evidence.status,'PASS','structural reference only, not the criterion status');assert.equal(JSON.parse(bytes).criteria[0].status,'PENDING');
  const loop={...ref,id:relative+'#loop=loop',digest:hash({campaignDigest:ref.digest,loop:input.loops[0]})};assert.equal(routes.readWorkspaceEvidence({scope:f.scope,reference:loop}).observedAt,1);
  await assert.rejects(()=>routes.workspace('campaign.write',{...input,status:'COMPLETE'},'fake-complete'),{code:'CAMPAIGN_INCOMPLETE'});
  await assert.rejects(()=>routes.native('prepare',{...f.input,scope:{...f.scope,projectId:'other'}}),{code:'OWNER_HOST_SCOPE'});
  const narrow=createProjectHostRoutes(f.context,f.scope.projectId,{...selection,calls:['native:inspect']},f.trusted,()=>{});await assert.rejects(()=>narrow.native('prepare',f.input),{code:'OWNER_HOST_CALL_FORBIDDEN'});
  put(join(f.projectRoot,relative),{...JSON.parse(bytes),goal:'Changed'});assert.throws(()=>routes.readWorkspaceEvidence({scope:f.scope,reference:ref}),{code:'RESPONSE_LEDGER_DRIFT'});
 }finally{f.cleanup();}
});
test('project standard bytes retain the frozen original digest and source path aliases cannot bypass inventory',async()=>{
 const f=projectFixture();try{
  const provenance=JSON.parse(readFileSync(new URL('../../provenance/project-compatibility.json',import.meta.url)));const standard=inspectProjectStandard();assert.deepEqual(Object.fromEntries(standard.files.map(v=>[v.path,v.sha256])),provenance.standardFiles);
  mkdirSync(join(f.source,'nested'));symlinkSync(join(f.source,'ontology.txt'),join(f.source,'nested/link'));
  await assert.rejects(()=>f.service.prepare(f.input),{code:'SYMLINK'});
 }finally{f.cleanup();}
});
test('selected legacy project tools require session activation and preserve original helper input and request identity',async()=>{
 const calls=[],owners={capabilities:()=>({}),call:async()=>{},project:{calls:['native:inspect','workspace:inspect'],async call(...args){calls.push(args);return{authority:false,synthetic:true};}}},client={connection:{projectId:'synthetic',workspaceId:'synthetic-project-host',serviceId:'synthetic-service',version:'0.8.3'},status:async()=>({result:{legacy:{bound:true}}})},tools=createLegacyTools(client,owners),unwrap=r=>JSON.parse(r.content[0].text);
 const input={operation:'inspect',input:{projectId:'synthetic'},requestId:'original'};assert.equal(unwrap(await tools.call('evopilot_v01_workspace_project',input)).error.code,'SESSION_INACTIVE');await tools.call('evopilot_v01_activate',{});assert.equal(unwrap(await tools.call('evopilot_v01_workspace_project',input)).result.authority,false);assert.deepEqual(calls[0].slice(0,4),['workspace','inspect',input.input,'original']);
 assert(!createLegacyTools(client).definitions.some(v=>v.name==='evopilot_v01_native_project'));
});

test('project identity revoked during native validation blocks materialization into the changed workspace',async()=>{
 const f=projectFixture();try{
  await f.freeze();const marker=join(f.projectRoot,'workspace-project.json'),original=readFileSync(marker);
  f.control.afterValidation=()=>put(marker,{...JSON.parse(original),id:'other-workspace'});
  await assert.rejects(()=>f.service.materialize({scope:f.scope,id:f.input.id,packages:f.packages}),{code:'PROJECT_IDENTITY'});
  assert(!existsSync(join(f.stateRoot,'state/project-standards/private/synthetic/materials',f.input.id+'.json')));
  writeFileSync(marker,original);f.control.afterValidation=null;
  await f.service.materialize({scope:f.scope,id:f.input.id,packages:f.packages});assert.equal(f.service.checkLayout({scope:f.scope,id:f.input.id}).conforms,true);
 }finally{f.cleanup();}
});

for(const boundary of ['partial-stage','old-renamed','new-renamed'])test(`retained promotion resumes ${boundary} with original bytes, journal and immutable receipt`,()=>{
 const f=projectFixture();try{
  const current=join(f.root,'current'),candidate=join(f.root,'candidate'),archiveRoot=join(f.root,'archive'),retained=join(f.root,'retained');for(const p of [current,candidate,archiveRoot,retained])mkdirSync(p,{mode:0o700});
  put(join(current,'README.md'),'original navigation');put(join(current,'custom.txt'),'user customization');put(join(candidate,'README.md'),'new navigation');
  const options={id:'synthetic-promotion',candidateDigest:hash('synthetic-candidate'),completionDigest:hash('synthetic-completion'),current,candidate,archiveRoot,retained},plan=preparePromotion(options);
  if(boundary==='partial-stage'){
   rmSync(plan.next,{recursive:true});mkdirSync(plan.next,{mode:0o700});put(join(plan.next,'custom.txt'),'unknown partial bytes');assert.throws(()=>preparePromotion(options),{code:'PROJECT_PROMOTION_DRIFT'});assert.equal(readFileSync(join(current,'README.md'),'utf8'),'original navigation');
   put(join(plan.next,'custom.txt'),'user customization');
  }else{renameSync(plan.current,plan.previous);if(boundary==='new-renamed')renameSync(plan.next,plan.current);}
  assert.deepEqual(preparePromotion(options),plan);assert.throws(()=>preparePromotion({...options,completionDigest:hash('different-completion')}),{code:'PROJECT_PROMOTION_CONFLICT'});
  const receipt=finishPromotion(plan,retained),bytes=readFileSync(join(retained,'promotion-synthetic-promotion.receipt.json'));
  assert.equal(readFileSync(join(current,'README.md'),'utf8'),'new navigation');assert.equal(readFileSync(join(current,'custom.txt'),'utf8'),'user customization');assert.equal(readFileSync(join(plan.previous,'README.md'),'utf8'),'original navigation');
  put(join(current,'custom.txt'),'later edit');assert.deepEqual(finishPromotion(plan,retained),receipt);assert.deepEqual(readFileSync(join(retained,'promotion-synthetic-promotion.receipt.json')),bytes);assert.equal(readFileSync(join(current,'custom.txt'),'utf8'),'later edit');
 }finally{f.cleanup();}
});
