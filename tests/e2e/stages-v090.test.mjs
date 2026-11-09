// Synthetic source/owner/CI contracts exercise real stage composition and
// persistence. These are not real project acceptance or release decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { crc32 } from 'node:zlib';
import { RuntimeStore } from '../../dist/server/store.js';
import { initializeCredentials, tokenDigest } from '../../dist/server/security.js';
import { startRuntimeServer } from '../../dist/server/http.js';
import { ServiceError } from '../../dist/server/errors.js';
import { valueDigest, byteDigest } from '../../dist/lifecycle/base.js';
import { compileLifecycle } from '../../dist/lifecycle/compiler.js';
import { pinInstance, requiredChecksDigest, requestStage, recordStageOutcome, stageAdmission } from '../../dist/lifecycle/instance.js';
import { createCiStageAdapter } from '../../dist/adapters/stages.js';
import {createCorrectionService,prepareNativeRepairCapture,completeNativeRepairCapture} from '../../dist/lifecycle/correction.js';
import {readRecoveryFailureOrigins} from '../../dist/adapters/authority.js';
import {ownerRequestDigest} from '../../dist/adapters/published-owners.js';
import {completedPreparationSource,readCiPreparationEvidence,resolvePreparationLineage} from '../../dist/adapters/ci-preparation.js';
import {readVerificationFeedback} from '../../dist/adapters/stage-feedback.js';
import { ciSourceDigest, ciBuildDigest, readArtifactArchive, CI_ACCEPTANCE_REPORT_PATH } from '../../dist/adapters/artifacts.js';
import { nativeSha256, NATIVE_CONTRACT_DIGEST } from '../../vendor/compatibility/v1/native.mjs';
import { lifecycle, yaml, syntheticBindings, syntheticSourceTree,extension } from '../fixtures/lifecycle-v090.mjs';
function zip(entries){
  const local=[],central=[];let offset=0;
  for(const [path,value] of entries){const name=Buffer.from(path),data=Buffer.from(value),crc=crc32(data),l=Buffer.alloc(30),c=Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc,14);l.writeUInt32LE(data.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(name.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);local.push(l,name,data);central.push(c,name);offset+=l.length+name.length+data.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);
}
async function fixture({targetVersion,publicAssets=false,preparing=false,preparationGraph='single',repairComparison=false}={}){
  if(preparing)targetVersion??='1.0.0-rc.1';
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-ci-stage-')),stateRoot=join(dir,'state'),workspaceId='test',projectId='alpha';
  const actor={id:'executor',projects:[projectId],permissions:['read','execution.request'],revision:1,expiresAt:'2030-01-01T00:00:00Z'},data=lifecycle();
  const binding={ref:'binding:alpha/platform',workspaceId,projectId,provider:'github',host:'https://github.com',repository:'synthetic/project',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/platform',workflowPath:'.github/workflows/test.yml',runner:'ubuntu-latest',revision:1,expiresAt:actor.expiresAt};
  Object.assign(data.config.implementation,{provider:binding.provider,host:binding.host,repository:binding.repository,repositoryId:binding.repositoryId,defaultBranch:binding.defaultBranch});
  for(const stage of ['plan','verification'])data.config[stage].budget={timeoutSeconds:600,maxAttempts:2,maxConcurrency:2,maxLoops:1};
  const pin=owner=>({product:owner,id:'synthetic-'+owner,version:'1.0.0',specVersion:'v1',visibility:publicAssets?'public':'private',digest:nativeSha256(owner),standardDigest:nativeSha256(owner+'standard'),standardLockDigest:nativeSha256(owner+'lock'),producer:{product:owner,version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST}),references={ontology:pin('ontology'),harness:pin('harness')};
  const resources=[],owners=[];
  for(const kind of ['ontology','harness']){
    const reference=references[kind];Object.assign(data.assets[kind],{id:reference.id,version:reference.version,digest:reference.digest,visibility:reference.visibility});
    owners.push({ref:data.assets[kind].adapterRef,owner:kind,packageRoot:dir,workspaceRoot:dir,workspaceId,projects:[projectId]});
    resources.push({ref:data.assets[kind].mappingRef,workspaceId,projectId,role:'assets.'+kind+'.mappingRef',revision:1,expiresAt:actor.expiresAt,definition:{kind:'asset-map',owner:kind,reference,assessmentId:kind==='ontology'?'synthetic':null,evidenceOrigin:'SYNTHETIC'}});
  }
  for(const [stage,field,purpose] of [['candidate','buildWorkflowRef','build'],['verification','verifyWorkflowRef','verify']])resources.push({ref:data.config[stage][field],workspaceId,projectId,role:'config.'+stage+'.'+field,revision:1,expiresAt:actor.expiresAt,definition:{kind:'workflow',platformRef:binding.ref,purpose,outputContract:'runtime-ci/v1'}});
  const comparisonReference={...references.harness,id:'synthetic-comparison',digest:nativeSha256('synthetic-comparison')},comparisonCriteria={comparable:'comparable',regression:'regression',progress:'progress',transient:'transient'};
  if(repairComparison){actor.permissions.push('draft.write');resources.push({ref:data.config.verification.failurePolicyRef,workspaceId,projectId,role:'config.verification.failurePolicyRef',revision:1,expiresAt:actor.expiresAt,definition:{kind:'failure',onFailure:'BLOCK',onUnknown:'BLOCK',repairComparison:{schema:'runtime-repair-comparison-policy/v1',adapterRef:data.assets.harness.adapterRef,scope:{visibility:'private',projectId},reference:comparisonReference,criteria:comparisonCriteria}}});}
  if(preparing){
    data.extensions=[extension('prepare','before-candidate',[],'operation'),...(preparationGraph==='single'?[]:[extension('prepare-second','before-candidate',preparationGraph==='serial'?['project.prepare']:[],'operation')])];
    const add=(ref,role,definition)=>resources.push({ref,workspaceId,projectId,role,revision:1,expiresAt:actor.expiresAt,definition}),rows=[];
    for(const e of data.extensions){e.parameters.workflowRef='binding:alpha/'+e.id+'-workflow';e.budget={timeoutSeconds:60,maxAttempts:1,maxConcurrency:1,maxLoops:1};const row={stage:e.id,checkId:e.requirementRefs[0],owner:'harness',criterionId:'requirement',variantIds:['positive'],source:'ci-artifact'};rows.push(row);
      add(e.parameters.workflowRef,'extension.workflow',{kind:'workflow',platformRef:binding.ref,purpose:'prepare',outputContract:'runtime-ci/v1'});add(e.requirementRefs[0],'extension.requirement',{kind:'check',owner:'harness',criterionId:'requirement',variantIds:['positive']});add(e.evidenceMappingRef,'extension.mapping',{kind:'evidence-map',...references,rows:[row]});
    }
    add(data.config.verification.evidenceMappingRef,'config.verification.evidenceMappingRef',{kind:'evidence-map',...references,rows});
  }
  const config={schema:'runtime-integrations/v1',workspaceId,revision:1,owners,resources,platforms:[binding],credentials:[{ref:binding.credentialRef,workspaceId,projectId,provider:binding.provider,host:binding.host,tokenFile:join(dir,'unused-token'),revision:1,expiresAt:actor.expiresAt}]},path=join(dir,'integrations.json'),save=()=>writeFileSync(path,JSON.stringify(config),{mode:0o600});save();
  const definition=compileLifecycle(yaml(data),projectId).effective;assert(definition);
  const prepInput={definitionRevisionId:valueDigest('revision'),goalRef:'synthetic:goal',loopRef:'synthetic:loop',target:{id:'synthetic-target',version:targetVersion??'1.0.0-rc.1',title:'Synthetic candidate version test',scope:['Synthetic candidate bytes'],exclusions:[]},source:{provider:'github',repositoryId:'42',commit:'a'.repeat(40)},compatibility:'unchanged',documents:{...Object.fromEntries(['plan','impact','verification','rollback'].map(k=>[k,{path:join(dir,k+'.md'),digest:valueDigest(k)}])),migration:null},verification:{requirementsDigest:requiredChecksDigest(definition),checks:definition.nodes.flatMap(n=>n.checks.map(checkId=>({stageId:n.id,checkId,source:'owner-receipt',procedure:'Synthetic test binding'})))}};
  const prepBody={schema:'runtime-preparation/v1',workspaceId,projectId,semanticDigest:definition.semanticDigest,input:prepInput},prep={...prepBody,digest:valueDigest(prepBody)};
  const authority={projectId,instanceId:'instance',definitionRevisionId:valueDigest('revision'),semanticDigest:definition.semanticDigest,requirementsDigest:requiredChecksDigest(definition),goalRef:'synthetic:goal',targetRef:targetVersion?'preparation:'+prep.digest:'synthetic:target',loopRef:'synthetic:loop',budget:data.config.plan.budget,evidenceRef:'synthetic:authority',revision:'one',expiresAt:actor.expiresAt},admission={authority,bindingsCurrent:true};
  let instance=pinInstance('instance',authority.definitionRevisionId,definition,authority),store=new RuntimeStore(stateRoot,workspaceId),adapter,request;
  if(targetVersion)store.mutate(actor,{projectId,operation:'synthetic.fixture',requestId:'synthetic-preparation',expectedRevision:0,input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'lifecycle-preparation',id:authority.targetRef,value:prep}],value:{synthetic:true},event:{type:'synthetic-preparation-fixture',data:{synthetic:true}}}));
  const predecessorOutcomes={};for(const id of ['scope','plan','implementation']){instance=requestStage(instance,id,'synthetic-'+id,admission);const outcome={requestId:'synthetic-'+id,inputDigest:instance.stages[id].inputDigest,receiptRef:'synthetic:predecessor',status:'COMPLETE',expiresAt:new Date(Date.now()+600000).toISOString(),checks:definition.nodes.find(n=>n.id===id).checks.map(id=>({id,status:'PASS',evidenceRef:'synthetic:check'}))};predecessorOutcomes[id]=outcome;instance=recordStageOutcome(instance,id,outcome);}
  if(preparing){
    const objects=[];for(const stageId of ['scope','plan','implementation']){const st=instance.stages[stageId],plan={adapterId:'synthetic',adapterDigest:valueDigest('synthetic'),action:'base.'+stageId,bindingDigest:valueDigest({}),parameters:{}},body={schema:'runtime-stage-request/v1',id:st.requestId,workspaceId,projectId,instanceId:instance.id,stageId,pinsDigest:instance.pinsDigest,inputDigest:st.inputDigest,bindingStamp:valueDigest('synthetic'),authorityRef:authority.evidenceRef,releaseAuthorityRef:null,initiatedBy:{id:actor.id,revision:actor.revision},plan,planDigest:valueDigest(plan),requestedAt:new Date().toISOString(),deadlineAt:actor.expiresAt},r={...body,digest:valueDigest(body)},outcome=predecessorOutcomes[stageId];
      objects.push({kind:'stage-request',id:r.id,value:r},{kind:'stage-progress',id:r.id,value:{requestId:r.id,phase:'COMPLETE',terminal:true,handle:null,observation:{outcome},observationRef:null,reason:null,observedAt:new Date().toISOString()}});
    }
    store.mutate(actor,{projectId,operation:'synthetic.predecessors',requestId:'synthetic-predecessors',expectedRevision:store.revision(projectId),input:{synthetic:true},permission:'read'},()=>({objects,value:{synthetic:true},event:{type:'synthetic-predecessors',data:{synthetic:true}}}));
  }
  const controls={status:'PASSED',ownerFail:null,ownerLost:null,missingCriterion:false,wrongContext:false,observationMissing:false,commit:'a'.repeat(40),sourceCommit:'a'.repeat(40),sourceRef:'synthetic:verified-implementation',preparedCommit:'c'.repeat(40),preparedCommits:{},runId:'23',changedArchive:false},calls=[],receipts=new Map(),toolchainLockDigest=valueDigest('synthetic-toolchain'),effectiveConfigDigest=valueDigest({params:{}});
  if(preparing){controls.commit='b'.repeat(40);controls.sourceCommit=controls.commit;}
  const ownerAdapters=Object.fromEntries(['ontology','harness'].map(kind=>[owners.find(o=>o.owner===kind).ref,{owner:kind,workspaceId,
    capabilities:()=>({registrationDigest:valueDigest({kind,synthetic:true})}),
    readPackage:async(_a,_p,_s,reference)=>{
      if(kind==='ontology')return{package:{manifest:{entrypoints:{cases:'cases.json'}},files:{'cases.json':JSON.stringify({cases:[{id:'positive',requirementIds:['scope']}]})}}};
      if(reference?.id===comparisonReference.id){const body={reference:comparisonReference,qualityStatus:'PASS',effectiveConfigDigest};return{validation:{...body,reportDigest:nativeSha256(body)},package:{manifest:{entrypoints:{coverage:'coverage.json'}},files:{'coverage.json':JSON.stringify({requirements:Object.values(comparisonCriteria).map(id=>({id,ruleIds:[id],caseIds:['positive']}))})}}};}
      const body={reference:references.harness,qualityStatus:'PASS',effectiveConfigDigest};return{validation:{...body,reportDigest:nativeSha256(body)},package:{manifest:{entrypoints:{coverage:'coverage.json'}},files:{'coverage.json':JSON.stringify({requirements:[{id:'requirement',ruleIds:['requirement'],caseIds:['positive']}]})}}};
    },
    read:async(_a,_p,r)=>{calls.push({kind,operation:r.operation});if(r.operation==='workspace.inspect')return{revision:0};const receipt=receipts.get(r.input.requestId);if(!receipt)throw new ServiceError('NOT_FOUND','Synthetic absent receipt',404);return structuredClone(receipt);},
    mutate:async(_a,_p,r)=>{
      const comparison=r.input.id===comparisonReference.id;
      calls.push({kind,operation:r.operation,request:r});assert(store.object(projectId,comparison?'lifecycle-recovery-ledger':'stage-native-action',comparison?'comparison-action:'+request.id:request.id+':'+kind),'durable before effect');
      const context=controls.wrongContext?{...r.input.context,inputDigest:valueDigest('wrong')}:r.input.context,criteria=(kind==='ontology'?[{criterionId:'scope',variantId:'positive'}]:[{criterionId:'requirement',variantId:'positive'},{criterionId:'requirement',variantId:'actual-observation'}]).map(p=>({...p,status:controls.ownerFail===kind?'FAIL':'PASS',evidenceDigest:valueDigest(p)}));
      if(controls.actualFailure&&kind==='harness'&&!comparison)criteria.find(c=>c.variantId==='actual-observation').status='FAIL';
      if(comparison)criteria.splice(0,criteria.length,...Object.values(comparisonCriteria).flatMap(criterionId=>['positive','actual-observation'].map(variantId=>({criterionId,variantId,status:variantId==='positive'?'PASS':controls.comparison?.[criterionId]??(criterionId==='transient'?'FAIL':'PASS'),evidenceDigest:valueDigest({criterionId,variantId})}))));
      if(controls.missingCriterion)criteria.pop();
      const body={context,toolchainLockDigest,criteria,...(kind==='ontology'?{status:controls.ownerFail===kind?'NONCONFORMING':'CONFORMS',packageDigest:references.ontology.digest,standardPins:{standardDigest:references.ontology.standardDigest,standardLockDigest:references.ontology.standardLockDigest}}:{reference:comparison?comparisonReference:references.harness,qualityStatus:criteria.some(c=>c.status==='FAIL')?'FAIL':'PASS',executionStatus:'SUCCEEDED',observationDigest:nativeSha256(r.input.observation),effectiveConfigDigest})};
      const receipt={requestId:r.requestId,operation:r.operation,scope:r.scope,requestDigest:nativeSha256({operation:r.operation,scope:r.scope,input:r.input}),result:{...body,reportDigest:nativeSha256(body)}};receipts.set(r.requestId,receipt);
      if(controls.ownerLost===kind||comparison&&controls.comparisonLost)throw new ServiceError('SYNTHETIC_RESPONSE_LOST','Synthetic loss',503);return receipt;
    },
  }]));
  const platform={revision:async(_actor,selected)=>({bindingDigest:valueDigest(binding),projectId,repositoryId:'42',commit:selected,workflowDigest:valueDigest('workflow'),expiresAt:actor.expiresAt,sourceSelection:'exact-commit',branchHeadCommit:controls.commit}),readiness:async()=>({bindingDigest:valueDigest(binding),projectId,repositoryId:'42',commit:controls.commit,workflowDigest:valueDigest('workflow'),expiresAt:actor.expiresAt}),
    sourceTree:async(_actor,{commit})=>{calls.push({operation:'source.tree',commit});const tree=syntheticSourceTree(binding,commit);if(preparing){tree.entries=[{path:'generated.ts',type:'blob',mode:'100644',objectId:'d'.repeat(40)}];tree.inventoryDigest=valueDigest(tree.entries);tree.treeDigest=valueDigest({schema:'runtime-git-tree-identity/v1',rootTreeId:tree.rootTreeId,inventoryDigest:tree.inventoryDigest});const{schema,factsDigest,observedAt,contentRead,linksFollowed,sourceApproved,...facts}=tree;tree.factsDigest=valueDigest(facts);}if(controls.invalidTree)tree.commit='f'.repeat(40);return tree;},
    source:async(_actor,input)=>{calls.push({operation:'source.read',input});const facts={provider:'github',projectId,repositoryId:binding.repositoryId,bindingDigest:valueDigest(binding),...input,state:'OPEN',draft:true,sourceBranch:'prepare',targetBranch:binding.defaultBranch,changes:input.artifacts.map(a=>({path:a.path,previousPath:null,status:'added'}))};if(controls.wrongPreparedSource)facts.parentCommit='f'.repeat(40);return{schema:'runtime-source-observation/v1',...facts,evidenceRef:'synthetic:source',observedAt:new Date().toISOString(),factsDigest:valueDigest(facts),sourceReviewApproved:false,ciVerified:false,releaseAuthorized:false};},
    dispatch:async(ci,permit)=>{await permit(ci);const retained=store.object(projectId,'lifecycle-instance',instance.id)?.stages[ci.stageId].requestId;if(retained)request=store.object(projectId,'stage-request',retained)??request;calls.push({operation:'ci.dispatch',ci});if(controls.lostCI)throw new ServiceError('SYNTHETIC_RESPONSE_LOST','Synthetic CI response loss',503);return run(ci);},run:async(_a,ci)=>{calls.push({operation:'ci.inspect',ci});return run(ci);},
    artifact:async(_a,ci)=>{
      calls.push({operation:'ci.artifact'});const values=JSON.stringify({schema:'runtime-ci-owner-values/v1',values:{healthy:!controls.changedArchive,...(controls.extraObservation?{payload:controls.extraObservation}:{})}}),content='synthetic software bytes',path=controls.observationMissing?'evidence/other.json':'evidence/owner-values.json';
      const result={schema:'runtime-ci/v1',requestId:ci.requestId,inputDigest:ci.inputDigest,provider:'github',repositoryId:'42',runId:controls.runId,sourceCommit:ci.commit,workflowDigest:ci.workflowDigest,stageId:ci.stageId,candidateDigest:ci.candidateDigest,checks:request.plan.parameters.expectedChecks.map(id=>({id,status:'PASS',evidence:[{path,digest:byteDigest(values),bytes:Buffer.byteLength(values)}]}))};
      if(ci.preparationInput)result.preparationOutput={schema:'runtime-ci-preparation-output/v1',inputDigest:valueDigest(ci.preparationInput),source:{commit:controls.preparedCommits[ci.stageId]??controls.preparedCommit,change:{kind:'pull-request',id:'2'},artifacts:[{path:'generated.ts',bytes:15,digest:byteDigest('prepared source')}]}};
      if(ci.stageId==='candidate')result.candidate={schema:'runtime-candidate/v1',profile:'candidate-verification',version:'1.0.0-rc.1',sourceDigest:ciSourceDigest(ci,'github','42'),buildDigest:ciBuildDigest(ci,controls.runId),artifacts:[{name:'software.tgz',digest:byteDigest(content),bytes:Buffer.byteLength(content)}]};
      const acceptance=[];
      if(controls.acceptanceReport){
        const pin=(path,bytes)=>({path,digest:byteDigest(bytes),bytes:Buffer.byteLength(bytes)}),raw=' {"synthetic":true,"outcome":"'+(controls.caseOutcome??'PASS')+'"}\r\n',workflow=JSON.stringify('workflow'),collector='synthetic collector';
        const report={schema:'runtime-ci-acceptance-report/v1',requestId:ci.requestId,inputDigest:ci.inputDigest,sourceCommit:ci.commit,workflowDigest:ci.workflowDigest,candidateDigest:result.candidate?valueDigest(result.candidate):ci.candidateDigest,requirementsDigest:instance.pins.requirementsDigest,producerJobId:'71',workflow:{sourcePath:binding.workflowPath,file:pin('evidence/workflow.txt',workflow)},collector:{sourcePath:'tests/collector.mjs',file:pin('evidence/collector.txt',collector)},cases:[{caseId:'SYNTHETIC.CASE',outcome:controls.caseOutcome??'PASS',rawReceipt:pin('evidence/case.json',raw)}]};
        acceptance.push([CI_ACCEPTANCE_REPORT_PATH,controls.invalidAcceptanceReport?'{':JSON.stringify(report)],['evidence/workflow.txt',workflow],['evidence/collector.txt',collector],['evidence/case.json',raw]);result.checks[0].evidence.push(...acceptance.map(([name,bytes])=>pin(name,bytes)));
      }
      if(ci.candidateInput)result.candidateConsumption={inputDigest:valueDigest(ci.candidateInput),artifacts:ci.candidateInput.manifest.artifacts};const bytes=zip([['runtime-result.json',JSON.stringify(result)],[path,values],...(ci.stageId==='candidate'?[['artifacts/software.tgz',content]]:[]),...(ci.candidateInput?[['candidate/software.tgz',content]]:[]),...(ci.preparationInput?[['prepared-source/generated.ts','prepared source']]:[]),...acceptance]);
      return{provider:'github',repositoryId:'42',requestId:ci.requestId,inputDigest:ci.inputDigest,bindingDigest:ci.bindingDigest,commit:ci.commit,runId:controls.runId,runStatus:controls.status,artifactId:'99',jobId:null,name:'runtime-ci',archiveDigest:byteDigest(bytes),archiveBytes:bytes.length,bytes,evidenceRef:'https://github.com/synthetic/project/actions/runs/'+controls.runId};
    }};
  function run(ci){return{schema:'runtime-ci-observation/v1',requestId:ci.requestId,inputDigest:ci.inputDigest,provider:'github',repositoryId:'42',ref:'evopilot-runtime/'+ci.requestId,commit:ci.commit,runId:controls.runId,status:controls.status,jobs:[],evidenceRef:'synthetic:ci',observedAt:'2026-01-01T00:00:00Z',factsDigest:valueDigest('synthetic'),artifactsVerified:false,lifecycleAcceptance:false};}
  const connect=()=>adapter=createCiStageAdapter(store,path,{platform:()=>platform,owner:ref=>ownerAdapters[ref],source:async(i,id)=>preparing?resolvePreparationLineage(i.definition.nodes,id,{commit:controls.sourceCommit,evidenceRef:controls.sourceRef},stageId=>completedPreparationSource(store,i,stageId)):({commit:controls.sourceCommit,evidenceRef:controls.sourceRef}),preparationInput:async(i,_id,source)=>({schema:'runtime-ci-preparation-input/v1',baselineCommit:prepInput.source.commit,parentCommit:source.commit,change:{kind:'pull-request',id:'1'},requirementsDigest:i.pins.requirementsDigest}),toolchainLockDigest,...(controls.toolchainManifestDigest?{toolchainManifestDigest:controls.toolchainManifestDigest}:{})});connect();
  const signal=()=>AbortSignal.timeout(5000),permit=async()=>actor,progress={requestId:'unused',phase:'RUNNING',terminal:false,handle:null,observation:null,observationRef:null,reason:null,observedAt:new Date().toISOString()};
  async function prepare(stage='candidate',correctionRef){
    const plan=await adapter.prepare(instance,stage,actor,signal()),id='request-'+stage+(repairComparison?'-'+instance.id:''),inputDigest=stageAdmission(instance,stage,admission).inputDigest,body={schema:'runtime-stage-request/v1',id,workspaceId,projectId,instanceId:instance.id,stageId:stage,pinsDigest:instance.pinsDigest,inputDigest,bindingStamp:valueDigest('synthetic'),authorityRef:authority.evidenceRef,releaseAuthorityRef:null,initiatedBy:{id:actor.id,revision:actor.revision},...(correctionRef?{correctionRef}:{}),plan,planDigest:valueDigest(plan),requestedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+120000).toISOString()};
    if(correctionRef){const proposal=store.object(projectId,'lifecycle-correction-proposal',correctionRef);body.deadlineAt=proposal.verificationBinding.deadlineAt;}
    request={...body,digest:valueDigest(body)};instance=requestStage(instance,stage,id,admission);if(preparing)store.mutate(actor,{projectId,operation:'synthetic.stage',requestId:'retain-'+id,expectedRevision:store.revision(projectId),input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'stage-request',id,value:request}],value:{synthetic:true},event:{type:'synthetic-stage',data:{synthetic:true}}}));return request;
  }
  return{dir,config,save,actor,controls,calls,receipts,signal,prepare,permit,authority,definition,data,setInstance(v,a){instance=v;if(a)admission.authority=a;},get store(){return store;},get request(){return request;},get instance(){return instance;},get adapter(){return adapter;},dispatch:()=>adapter.dispatch(request,instance,permit,signal()),inspect:()=>adapter.inspect(request,instance,progress,actor,signal()),advance:(p=permit)=>adapter.advance(request,instance,progress,p,signal()),complete(o){instance=recordStageOutcome(instance,request.stageId,o.outcome);if(preparing)store.mutate(actor,{projectId,operation:'synthetic.completed',requestId:'complete-'+request.id,expectedRevision:store.revision(projectId),input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'stage-progress',id:request.id,value:{requestId:request.id,phase:o.phase,terminal:true,handle:o.handle,observation:o,observationRef:null,reason:null,observedAt:new Date().toISOString()}}],value:{synthetic:true},event:{type:'synthetic-completion',data:{synthetic:true}}}));},restart(){store.close();store=new RuntimeStore(stateRoot,workspaceId);connect();},
    async startService(){
      const token='a'.repeat(64);initializeCredentials(stateRoot,workspaceId,[{...actor,tokenDigest:tokenDigest(token)}]);
      store.mutate(actor,{projectId,operation:'synthetic.fixture',requestId:'seed',expectedRevision:store.revision(projectId),input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'lifecycle-instance',id:instance.id,value:instance},{kind:'instance-authority',id:instance.id,value:{evidenceRef:authority.evidenceRef}}],value:{synthetic:true},event:{type:'synthetic-fixture',data:{synthetic:true}}}));store.close();
      const bindings=syntheticBindings(),server=await startRuntimeServer({stateRoot,workspaceId},bindings.provider,async()=>authority,undefined,s=>{store=s;connect();return adapter;});return{server,token};
    },cleanup(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('candidate CI success waits for explicit owner continuation; exact receipts complete and persist its manifest',async()=>{
  const f=await fixture();try{
    await f.prepare();assert.equal((await f.dispatch()).phase,'RUNNING');assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,0);
    assert.equal((await f.inspect()).phase,'RUNNING');const o=await f.advance();assert.equal(o.phase,'COMPLETE');assert.equal(o.outcome.candidate.version,'1.0.0-rc.1');assert.equal(o.outcome.checks.every(c=>c.status==='PASS'),true);
    assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch').length,1);assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,2);
    assert.equal(readdirSync(join(f.store.root,'stage-ci-artifacts')).filter(p=>p.endsWith('.zip')).length,1);f.complete(o);assert.equal(f.instance.stages.candidate.status,'PASSED');
  }finally{f.cleanup();}
});
test('a candidate must match the reviewed target version before owner validation can run',async()=>{
  const wrong=await fixture({targetVersion:'2.0.0'});try{await wrong.prepare();const result=await wrong.dispatch();assert.equal(result.phase,'FAILED');assert.equal(result.outcome.candidate,undefined);assert.equal(result.outcome.checks.find(c=>c.id==='base.candidate.immutable-manifest').status,'FAIL');assert.equal(wrong.calls.filter(x=>x.operation==='native.package.validate').length,0);}finally{wrong.cleanup();}
  const matching=await fixture({targetVersion:'1.0.0-rc.1'});try{await matching.prepare();await matching.dispatch();assert.equal((await matching.advance()).phase,'COMPLETE');}finally{matching.cleanup();}
});
test('restarting CI/native composition reuses original run and native receipts without new validation',async()=>{
  const f=await fixture();try{await f.prepare();await f.dispatch();await f.advance();f.restart();assert.equal((await f.inspect()).phase,'COMPLETE');assert.equal((await f.advance()).phase,'COMPLETE');assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch').length,1);assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,2);}finally{f.cleanup();}
});
test('CI-running inspection and explicit continuation never start owner effects early',async()=>{
  const f=await fixture();try{await f.prepare();f.controls.status='RUNNING';assert.equal((await f.dispatch()).phase,'CI_RUNNING');assert.equal((await f.advance()).phase,'CI_RUNNING');assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,0);f.controls.status='PASSED';assert.equal((await f.advance()).phase,'COMPLETE');}finally{f.cleanup();}
});
test('lost first owner response is independently reconciled and only the remaining owner is dispatched',async()=>{
  const f=await fixture();try{await f.prepare();await f.dispatch();f.controls.ownerLost='ontology';await assert.rejects(()=>f.advance(),{code:'SYNTHETIC_RESPONSE_LOST'});f.restart();assert.equal((await f.inspect()).phase,'RUNNING');f.controls.ownerLost=null;assert.equal((await f.advance()).phase,'COMPLETE');assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,2);}finally{f.cleanup();}
});
test('failed native quality cannot be replaced by CI success or a complete artifact',async()=>{
  const f=await fixture();try{await f.prepare();await f.dispatch();f.controls.ownerFail='harness';const o=await f.advance();assert.equal(o.phase,'FAILED');assert.equal(o.outcome.candidate,undefined);assert(o.outcome.checks.every(c=>c.status==='FAIL'));}finally{f.cleanup();}
});
test('a known failed CI run stays failed even when it has no usable artifact',async()=>{
  const f=await fixture();try{await f.prepare();f.controls.status='FAILED';const o=await f.dispatch();assert.equal(o.phase,'FAILED');assert.equal(f.calls.filter(x=>x.operation==='ci.artifact'||x.operation==='native.package.validate').length,0);const [capture]=f.store.objectsPage('alpha','ci-acceptance-capture').map(r=>r.value);assert.equal(capture.origin.runStatus,'FAILED');assert.equal(capture.report.status,'UNAVAILABLE');assert.equal(capture.history,'UNKNOWN');assert.equal(capture.qualification,'UNAVAILABLE');}finally{f.cleanup();}
});
test('optional case capture keeps original ZIP references and all authority flags closed across restart',async()=>{
  const f=await fixture();try{
    f.controls.acceptanceReport=true;f.controls.caseOutcome='CANCELLED';await f.prepare();await f.dispatch();
    const captured=f.store.objectsPage('alpha','ci-acceptance-capture').map(r=>r.value);assert.equal(captured.length,1);const c=captured[0];
    assert.equal(c.schema,'runtime-ci-acceptance-capture/v1');assert.equal(c.stageRequestDigest,f.request.digest);assert.equal(c.stageRequestId,f.request.id);assert.notEqual(c.origin.ciRequestId,c.stageRequestId);assert.deepEqual(c.origin.providerAttempt,{kind:'GITHUB_RUN_ATTEMPT',runId:'23',number:1});assert.equal(c.origin.sourceApproved,false);assert.equal(c.report.status,'OBSERVED');assert.equal(c.report.cases[0].observedOutcome,'CANCELLED');assert.equal(c.report.collectorSemanticApproval,'UNKNOWN');
    assert.equal(c.history,'UNKNOWN');assert.equal(c.inputClosure,'UNKNOWN');assert.equal(c.qualification,'UNAVAILABLE');for(const key of ['reuseAuthorized','executionAuthorized','releaseAuthorized'])assert.equal(c[key],false);
    const archive=readFileSync(join(f.store.root,'stage-ci-artifacts',c.origin.archive.archiveDigest.slice(7)+'.zip')),files=await readArtifactArchive(archive,f.signal()),raw=c.report.cases[0].rawReceipt;
    assert.equal(byteDigest(files.get(raw.path)),raw.digest);assert(files.get(raw.path).toString().endsWith('\r\n'));assert.equal(c.report.rawText,undefined);
    f.restart();await f.inspect();assert.deepEqual(f.store.objectsPage('alpha','ci-acceptance-capture').map(r=>r.value),captured);assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch').length,1);assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,0);
  }finally{f.cleanup();}
});
test('missing and malformed optional reports leave the existing stage flow intact and cannot create eligible evidence',async()=>{
  for(const invalid of [false,true]){const f=await fixture();try{
    f.controls.acceptanceReport=invalid;f.controls.invalidAcceptanceReport=invalid;await f.prepare();await f.dispatch();const [c]=f.store.objectsPage('alpha','ci-acceptance-capture').map(r=>r.value);assert.equal(c.report.status,invalid?'INVALID':'ABSENT');assert.deepEqual(c.report.cases,[]);assert.equal(c.qualification,'UNAVAILABLE');assert.equal((await f.advance()).phase,'COMPLETE');
  }finally{f.cleanup();}}
});
test('unknown CI observations remain separately retained when a later report arrives',async()=>{
  const f=await fixture();try{
    f.controls.status='UNKNOWN';await f.prepare();assert.equal((await f.dispatch()).phase,'UNKNOWN');f.controls.status='PASSED';f.controls.acceptanceReport=true;await f.inspect();
    const captures=f.store.objectsPage('alpha','ci-acceptance-capture').map(r=>r.value);assert.equal(captures.length,2);assert(captures.some(c=>c.origin.runStatus==='UNKNOWN'&&c.report.status==='UNAVAILABLE'));assert(captures.some(c=>c.report.status==='OBSERVED'));assert(captures.every(c=>c.history==='UNKNOWN'&&c.reuseAuthorized===false));
  }finally{f.cleanup();}
});
test('an owner execution failure receipt is a failure, not a manufactured quality PASS',async()=>{
  const f=await fixture();try{
    await f.prepare();await f.dispatch();await f.advance();
    const request=f.calls.find(x=>x.kind==='harness'&&x.operation==='native.package.validate').request,receipt=f.receipts.get(request.requestId);receipt.status='FAILED';receipt.result=null;
    const o=await f.inspect();assert.equal(o.phase,'FAILED');assert.equal(o.outcome.candidate,undefined);
  }finally{f.cleanup();}
});
for(const [control,code] of [['missingCriterion','OWNER_REPORT_INCOMPLETE'],['wrongContext','OWNER_REPORT_MISMATCH'],['observationMissing','OWNER_OBSERVATION_MISSING']])test('native stage rejects '+control+' evidence rather than inferring owner quality',async()=>{
  const f=await fixture();try{f.controls[control]=true;await f.prepare();await f.dispatch();await assert.rejects(()=>f.advance(),{code});}finally{f.cleanup();}
});
test('reconciliation cannot replace an original run, artifact or platform registration',async()=>{
  const f=await fixture();try{
    await f.prepare();await f.dispatch();f.controls.runId='24';await assert.rejects(()=>f.inspect(),{code:'STAGE_EVIDENCE_CHANGED'});f.controls.runId='23';f.controls.changedArchive=true;await assert.rejects(()=>f.inspect(),{code:'STAGE_EVIDENCE_CHANGED'});
    f.config.platforms[0].revision++;f.save();await assert.rejects(()=>f.inspect(),{code:'PLATFORM_BINDING_CHANGED'});
  }finally{f.cleanup();}
});
test('registered native manifest remains pinned across restart even when the declared native lock stays the same',async()=>{
  const f=await fixture();try{
    f.controls.toolchainManifestDigest=valueDigest('original-manifest');f.restart();await f.prepare();await f.dispatch();
    assert.equal(f.request.plan.parameters.toolchainManifestDigest,f.controls.toolchainManifestDigest);
    f.controls.toolchainManifestDigest=valueDigest('changed-manifest');f.restart();await assert.rejects(()=>f.inspect(),{code:'TOOLCHAIN_CHANGED'});await assert.rejects(()=>f.advance(),{code:'TOOLCHAIN_CHANGED'});
    assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,0);assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch').length,1);
    f.controls.toolchainManifestDigest=valueDigest('original-manifest');f.restart();assert.equal((await f.advance()).phase,'COMPLETE');
  }finally{f.cleanup();}
});
test('a revoked continuation permit cannot mutate owners, and unrelated stages remain unavailable',async()=>{
  const f=await fixture();try{await f.prepare();await f.dispatch();await assert.rejects(()=>f.advance(async()=>{throw new ServiceError('AUTHORITY_REVOKED','Synthetic revocation',403);}),{code:'AUTHORITY_REVOKED'});assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,0);await assert.rejects(()=>f.adapter.prepare(f.instance,'publication',f.actor,f.signal()),{code:'STAGE_ADAPTER_UNAVAILABLE'});}finally{f.cleanup();}
});
test('verification pins the prior candidate and cannot rebuild or follow another source commit',async()=>{
  const f=await fixture();try{
    await f.prepare();await f.dispatch();f.complete(await f.advance());const digest=f.instance.candidateDigest;
    f.controls.sourceCommit='b'.repeat(40);await assert.rejects(()=>f.adapter.prepare(f.instance,'verification',f.actor,f.signal()),{code:'CANDIDATE_SOURCE_CHANGED'});f.controls.sourceCommit='a'.repeat(40);f.controls.commit='c'.repeat(40);
    await f.prepare('verification');await f.dispatch();const o=await f.advance();assert.equal(o.phase,'COMPLETE');assert.equal(o.outcome.candidate,undefined);f.complete(o);assert.equal(f.instance.candidateDigest,digest);
  }finally{f.cleanup();}
});
test('HTTP service owns the native CI adapter store and completes the same original stage through explicit advance',async()=>{
  const f=await fixture();let server;
  try{
    const opened=await f.startService();server=opened.server;let serial=0;
    const call=async(operation,input={},write=false)=>{
      const response=await fetch(server.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+opened.token,'content-type':'application/json'},body:JSON.stringify({operation,projectId:'alpha',input,...(write?{requestId:'http-'+(++serial),expectedRevision:f.store.revision('alpha')}:{})})});
      const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.result;
    };
    const started=await call('lifecycle.stage.request',{instanceId:'instance',stageId:'candidate'},true),id=started.result.stageRequestId;
    const wait=async(phase,stageRequestId=id)=>{for(let n=0;n<100;n++){const state=await call('lifecycle.stage.request.inspect',{stageRequestId});if(state.progress.phase===phase)return state;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected native stage phase '+phase);};
    await wait('RUNNING');assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,0);
    const advanced=await call('lifecycle.stage.advance',{stageRequestId:id},true);assert.equal(advanced.result.newAttempt,false);await wait('COMPLETE');
    const saved=await call('lifecycle.instance.inspect',{instanceId:'instance'});assert.equal(saved.instance.stages.candidate.attempts,1);assert(saved.instance.candidateDigest);assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch').length,1);assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,2);
    const verified=await call('lifecycle.stage.request',{instanceId:'instance',stageId:'verification'},true),verificationId=verified.result.stageRequestId;
    await wait('RUNNING',verificationId);await call('lifecycle.stage.advance',{stageRequestId:verificationId},true);await wait('COMPLETE',verificationId);
    const feedback=await call('lifecycle.verification.feedback.read',{stageRequestId:verificationId});assert.equal(feedback.event.stage,'SUCCEEDED');assert.equal(feedback.event.projectCandidateDigest,saved.instance.candidateDigest);assert.equal(feedback.feedbackDelivered,false);assert.equal(feedback.releaseAuthorized,false);assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,4);
  }finally{await server?.close();f.cleanup();}
});

test('new native CI requests bind complete source scope and preserve the original collected observation',async()=>{
  const f=await fixture();try{await f.prepare();assert.equal(f.request.plan.adapterId,'runtime-ci-owner-stage-v2');const p=f.request.plan.parameters;assert.equal(p.sourceScope.treeDigest,p.sourceTree.treeDigest);assert.equal(p.sourceScope.inventoryDigest,p.sourceTree.inventoryDigest);assert.equal(p.sourceScope.requirementsDigest,f.instance.pins.requirementsDigest);await f.dispatch();await f.advance();const a=f.store.object('alpha','stage-native-action',f.request.id+':harness');assert.equal(a.context.sourceScopeDigest,nativeSha256(p.sourceScope));assert.equal(a.request.input.observation.source.digest,p.sourceTree.treeDigest);assert.equal(a.request.input.observation.source.revision,p.commit);assert.equal(a.request.input.observation.collectionReceiptRef.claimId,a.context.claimId);f.restart();assert.equal((await f.inspect()).phase,'COMPLETE');assert.equal(f.calls.filter(x=>x.operation==='source.tree').length,1);}finally{f.cleanup();}
});
test('wrong source inventory blocks new CI preparation without dispatch or owner mutation',async()=>{
  const f=await fixture();try{f.controls.invalidTree=true;await assert.rejects(()=>f.prepare(),{code:'SOURCE_TREE_CHANGED'});assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch'||x.operation==='native.package.validate').length,0);}finally{f.cleanup();}
});
test('retained source scope cannot change even if outer plan digests are recomputed',async()=>{
  const f=await fixture();try{await f.prepare();const r=f.request;r.plan.parameters.sourceScope.treeDigest=valueDigest('foreign-tree');r.plan.bindingDigest=valueDigest(r.plan.parameters);r.planDigest=valueDigest(r.plan);const{digest,...body}=r;r.digest=valueDigest(body);await assert.rejects(()=>f.dispatch(),{code:'SOURCE_TREE_CHANGED'});assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch').length,0);}finally{f.cleanup();}
});
test('historical v1 CI request readback preserves its original context and does not gain source inventory',async()=>{
  const f=await fixture();try{await f.prepare();const r=f.request;delete r.plan.parameters.sourceScope;delete r.plan.parameters.sourceTree;r.plan.adapterId='runtime-ci-owner-stage-v1';r.plan.adapterDigest=valueDigest({id:r.plan.adapterId,stages:['implementation','candidate','verification'],source:'verified-exact-commit/v1',candidate:'immutable-archive-consumption/v1',workflow:'runtime-ci/v1',owners:'native/v1',observation:'runtime-ci-owner-values/v1',continuation:'explicit-original-request/v1'});r.plan.bindingDigest=valueDigest(r.plan.parameters);r.planDigest=valueDigest(r.plan);const{digest,...body}=r;r.digest=valueDigest(body);await f.dispatch();const result=await f.advance();assert.equal(result.phase,'COMPLETE');assert.equal(result.adapterDigest,r.plan.adapterDigest);const a=f.store.object('alpha','stage-native-action',r.id+':harness');assert.equal(a.context.sourceScopeDigest,ciSourceDigest({commit:r.plan.parameters.commit},'github','42'));assert.equal(a.request.input.observation.source.digest,a.context.sourceScopeDigest);f.restart();assert.equal((await f.inspect()).phase,'COMPLETE');assert.equal(f.request.plan.parameters.sourceTree,undefined);assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,2);}finally{f.cleanup();}
});

function syntheticCoreCommit(f,outcome){
  f.complete(outcome);const r=f.request,projectId='alpha',objects=[{kind:'stage-request',id:r.id,value:r},{kind:'lifecycle-instance',id:f.instance.id,value:f.instance},{kind:'stage-progress',id:r.id,value:{requestId:r.id,phase:outcome.phase,terminal:true,handle:outcome.handle,observation:outcome,observationRef:valueDigest(outcome),reason:null,observedAt:new Date().toISOString()}}];
  f.store.mutate(f.actor,{projectId,operation:'synthetic.core.commit',requestId:'synthetic-core-'+r.id,expectedRevision:f.store.revision(projectId),input:{synthetic:true},permission:'read'},()=>({objects,value:{synthetic:true},event:{type:'synthetic-core-terminal',data:{synthetic:true}}}));
}
const feedbackId=f=>nativeSha256({workspaceId:'test',scope:{visibility:'private',projectId:'alpha'},claimId:valueDigest({stageRequestDigest:f.request.digest})});
async function verificationFixture(options){const f=await fixture(options);await f.prepare();await f.dispatch();f.complete(await f.advance());await f.prepare('verification');await f.dispatch();return f;}
test('registered terminal verification feedback reuses exact native claims, source, CI and original receipts across restart',async()=>{
  const f=await verificationFixture();try{const outcome=await f.advance();syntheticCoreCommit(f,outcome);const id=feedbackId(f),event=readVerificationFeedback(f.store,f.actor,'alpha',id);assert.equal(event.stage,'SUCCEEDED');assert.equal(event.runId,'verification:'+f.request.id);assert.equal(event.runReviewDigest,f.request.planDigest);assert.deepEqual(event.source,f.request.plan.parameters.sourceScope);assert.equal(event.observation.sourceScopeDigest,nativeSha256(event.source));assert.equal(event.observation.source.digest,event.source.treeDigest);assert.equal(event.claimId,event.observation.collectionReceiptRef.claimId);assert.equal(event.collectionRefs[0].digest,event.observation.collectionReceiptRef.digest);for(const owner of ['ontology','harness'])assert.deepEqual(event.results[owner],f.store.object('alpha','stage-native-receipt',f.request.id+':'+owner));f.restart();assert.deepEqual(readVerificationFeedback(f.store,f.actor,'alpha',id),event);assert.equal(f.calls.filter(c=>c.operation==='native.package.validate').length,4);}finally{f.cleanup();}
});
test('native success retained before the execution core terminal commit cannot be delivered as completed feedback',async()=>{
  const f=await verificationFixture();try{const id=feedbackId(f);assert.throws(()=>readVerificationFeedback(f.store,f.actor,'alpha',id),{code:'FEEDBACK_RUN_INCOMPLETE'});const outcome=await f.advance();assert(f.store.object('alpha','stage-evaluation-run',f.request.id));assert.throws(()=>readVerificationFeedback(f.store,f.actor,'alpha',id),{code:'FEEDBACK_RUN_INCOMPLETE'});syntheticCoreCommit(f,outcome);assert.equal(readVerificationFeedback(f.store,f.actor,'alpha',id).stage,'SUCCEEDED');assert.throws(()=>readVerificationFeedback(f.store,{...f.actor,projects:['beta']},'alpha',id),{code:'FORBIDDEN'});assert.throws(()=>readVerificationFeedback(f.store,f.actor,'alpha',{id,status:'PASS'}));}finally{f.cleanup();}
});
test('native verification failures stay failed in the registered feedback event',async()=>{
  const f=await verificationFixture();try{f.controls.ownerFail='harness';const result=await f.advance();assert.equal(result.phase,'FAILED');syntheticCoreCommit(f,result);const event=readVerificationFeedback(f.store,f.actor,'alpha',feedbackId(f));assert.equal(event.stage,'FAILED');assert.equal(event.results.harness.result.qualityStatus,'FAIL');assert.equal(event.pins.harness.version,'1.0.0');}finally{f.cleanup();}
});
test('changed original native receipt prevents reuse of an otherwise retained feedback event',async()=>{
  const f=await verificationFixture();try{syntheticCoreCommit(f,await f.advance());const id=feedbackId(f),event=readVerificationFeedback(f.store,f.actor,'alpha',id),value=structuredClone(event.results.harness);value.result.qualityStatus='FAIL';f.store.mutate(f.actor,{projectId:'alpha',operation:'synthetic.fault',requestId:'synthetic-receipt-fault',expectedRevision:f.store.revision('alpha'),input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'stage-native-receipt',id:f.request.id+':harness',value}],value:{synthetic:true},event:{type:'synthetic-fault',data:{synthetic:true}}}));assert.throws(()=>readVerificationFeedback(f.store,f.actor,'alpha',id),{code:'OWNER_REPORT_MISMATCH'});}finally{f.cleanup();}
});
test('public asset references do not make private project feedback public',async()=>{
  const f=await verificationFixture({publicAssets:true});try{syntheticCoreCommit(f,await f.advance());const event=readVerificationFeedback(f.store,f.actor,'alpha',feedbackId(f));assert.equal(event.scope.visibility,'private');assert.equal(event.scope.projectId,'alpha');assert.equal(event.pins.ontology.visibility,'public');assert.equal(event.pins.harness.visibility,'public');}finally{f.cleanup();}
});

test('a missing or modified original CI archive cannot back a retained terminal feedback event',async()=>{
  const f=await verificationFixture();try{syntheticCoreCommit(f,await f.advance());const id=feedbackId(f),ci=f.store.object('alpha','ci-stage-artifact',f.request.id),path=join(f.store.root,'stage-ci-artifacts',ci.archiveDigest.slice(7)+'.zip'),bytes=readFileSync(path);bytes[bytes.length-1]^=1;writeFileSync(path,bytes);assert.throws(()=>readVerificationFeedback(f.store,f.actor,'alpha',id),{code:'FEEDBACK_RUN_MISMATCH'});}finally{f.cleanup();}
});

for(const unchanged of [false,true])test('registered CI preparation '+(unchanged?'retains unchanged':'propagates changed')+' source only after exact native completion',async()=>{
 const f=await fixture({preparing:true});try{
  if(unchanged)f.controls.preparedCommit=f.controls.sourceCommit;
  await f.prepare('project.prepare');assert.equal(f.request.plan.adapterId,'runtime-ci-preparation-stage-v1');const original=f.request;
  assert.equal((await f.dispatch()).phase,'RUNNING');assert(f.store.object('alpha','ci-preparation-observation',original.id));assert.equal(f.store.object('alpha','ci-preparation-source',original.id),null);assert.equal(f.calls.filter(c=>c.operation==='native.package.validate').length,0);
  await assert.rejects(()=>f.adapter.prepare(f.instance,'candidate',f.actor,f.signal()),{code:'CI_PREPARATION_INCOMPLETE'});
  const outcome=await f.advance();assert.equal(outcome.phase,'COMPLETE');assert.equal(outcome.outcome.candidate,undefined);f.complete(outcome);
  const proof=completedPreparationSource(f.store,f.instance,'project.prepare');assert.equal(proof.input.commit,'b'.repeat(40));assert.equal(proof.output.commit,f.controls.preparedCommit);
  const native=f.calls.find(c=>c.operation==='native.package.validate'&&c.kind==='harness').request.input.observation;assert.equal(native.source.revision,f.controls.preparedCommit);assert.equal(native.values.runtimePreparation.verifiedSource.source.parentCommit,'b'.repeat(40));assert.equal(native.values.runtimePreparation.verifiedSource.source.baselineCommit,'a'.repeat(40));assert.equal(native.values.runtimePreparation.sourceReviewApproved,undefined);
  const retained=readCiPreparationEvidence(f.store,original);assert(retained.proof);assert.equal(retained.owners.harness.result.status,'PASS');f.restart();assert.deepEqual(completedPreparationSource(f.store,f.instance,'project.prepare'),proof);assert.equal((await f.inspect()).phase,'COMPLETE');
  await f.prepare('candidate');assert.equal(f.request.plan.parameters.commit,f.controls.preparedCommit);await f.dispatch();const candidate=await f.advance();assert.equal(candidate.phase,'COMPLETE');assert.equal(candidate.outcome.candidate.sourceDigest,ciSourceDigest({commit:f.controls.preparedCommit},'github','42'));assert.equal(f.calls.filter(c=>c.operation==='ci.dispatch').length,2);
 }finally{f.cleanup();}
});
test('lost preparation CI response inspects its original run and never repeats dispatch',async()=>{
 const f=await fixture({preparing:true});try{await f.prepare('project.prepare');f.controls.lostCI=true;await assert.rejects(()=>f.dispatch(),{code:'SYNTHETIC_RESPONSE_LOST'});f.restart();f.controls.lostCI=false;assert.equal((await f.inspect()).phase,'RUNNING');const outcome=await f.advance();assert.equal(outcome.phase,'COMPLETE');f.complete(outcome);assert.equal(completedPreparationSource(f.store,f.instance,'project.prepare').output.commit,f.controls.preparedCommit);assert.equal(f.calls.filter(c=>c.operation==='ci.dispatch').length,1);assert.equal(f.calls.filter(c=>c.operation==='native.package.validate').length,2);}finally{f.cleanup();}
});
test('lost preparation owner response resumes only the remaining original native validation',async()=>{
 const f=await fixture({preparing:true});try{await f.prepare('project.prepare');await f.dispatch();f.controls.ownerLost='ontology';await assert.rejects(()=>f.advance(),{code:'SYNTHETIC_RESPONSE_LOST'});f.restart();f.controls.ownerLost=null;assert.equal((await f.inspect()).phase,'RUNNING');const outcome=await f.advance();f.complete(outcome);assert.equal(outcome.phase,'COMPLETE');assert.equal(f.calls.filter(c=>c.operation==='native.package.validate').length,2);assert.equal(f.calls.filter(c=>c.operation==='ci.dispatch').length,1);}finally{f.cleanup();}
});
test('unrelated preparation source prevents native effects and can reconcile the original CI after a read repair',async()=>{
 const f=await fixture({preparing:true});try{await f.prepare('project.prepare');f.controls.wrongPreparedSource=true;await assert.rejects(()=>f.dispatch(),{code:'CI_PREPARATION_SOURCE'});assert.equal(f.calls.filter(c=>c.operation==='native.package.validate').length,0);assert.equal(f.store.object('alpha','ci-preparation-observation',f.request.id),null);f.controls.wrongPreparedSource=false;f.restart();const outcome=await f.advance();assert.equal(outcome.phase,'COMPLETE');assert.equal(f.calls.filter(c=>c.operation==='ci.dispatch').length,1);}finally{f.cleanup();}
});
test('preparation failure, changed resources or missing retained proof cannot feed candidate creation',async()=>{
 const failed=await fixture({preparing:true});try{await failed.prepare('project.prepare');await failed.dispatch();failed.controls.ownerFail='harness';const outcome=await failed.advance();assert.equal(outcome.phase,'FAILED');failed.complete(outcome);assert.equal(failed.store.object('alpha','ci-preparation-source',failed.request.id),null);await assert.rejects(()=>failed.adapter.prepare(failed.instance,'candidate',failed.actor,failed.signal()),{code:'CI_PREPARATION_INCOMPLETE'});}finally{failed.cleanup();}
 for(const mutate of [f=>f.config.resources.find(r=>r.role==='extension.workflow').definition.purpose='publish',f=>f.config.resources.find(r=>r.role==='extension.mapping').definition.rows[0].source='decision']){const f=await fixture({preparing:true});try{mutate(f);f.save();await assert.rejects(()=>f.prepare('project.prepare'),e=>e.code.startsWith('CI_PREPARATION_'));assert.equal(f.calls.filter(c=>c.operation==='ci.dispatch').length,0);}finally{f.cleanup();}}
 const f=await fixture({preparing:true});try{await f.prepare('project.prepare');await f.dispatch();f.complete(await f.advance());const raw=f.store.object('alpha','ci-preparation-observation',f.request.id);raw.observation.source.commit='d'.repeat(40);f.store.mutate(f.actor,{projectId:'alpha',operation:'synthetic.corruption',requestId:'corrupt',expectedRevision:f.store.revision('alpha'),input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'ci-preparation-observation',id:f.request.id,value:raw}],value:{synthetic:true},event:{type:'synthetic-corruption',data:{synthetic:true}}}));assert.throws(()=>completedPreparationSource(f.store,f.instance,'project.prepare'),{code:'CORRUPT_CI_PREPARATION'});}finally{f.cleanup();}
});
test('HTTP lifecycle prepares changed source and its following candidate with one original attempt each',async()=>{
 const f=await fixture({preparing:true});let server;const client=new Client({name:'synthetic-ci-preparation',version:'1'});try{const opened=await f.startService();server=opened.server;let serial=0;
  const call=async(operation,input={},write=false)=>{const response=await fetch(server.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+opened.token,'content-type':'application/json'},body:JSON.stringify({operation,projectId:'alpha',input,...(write?{requestId:'prepare-http-'+(++serial),expectedRevision:f.store.revision('alpha')}:{})})});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.result;};
  const wait=async(id,phase)=>{let state;for(let n=0;n<150;n++){state=await call('lifecycle.stage.request.inspect',{stageRequestId:id});if(state.progress.phase===phase)return state;await new Promise(r=>setTimeout(r,20));}assert.fail(JSON.stringify(state));};
  const requested=await call('lifecycle.stage.request',{instanceId:'instance',stageId:'project.prepare'},true),id=requested.result.stageRequestId;await wait(id,'RUNNING');await call('lifecycle.stage.advance',{stageRequestId:id},true);await wait(id,'COMPLETE');const evidence=await call('lifecycle.extension.evidence.read',{stageRequestId:id});assert.equal(evidence.prepared.observation.source.commit,'c'.repeat(40));assert(evidence.proof);assert.equal(evidence.executionAuthorized,false);
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+opened.token}}}));const mcp=await client.callTool({name:'runtime_read',arguments:{operation:'lifecycle.extension.evidence.read',projectId:'alpha',input:{stageRequestId:id}}});assert.notEqual(mcp.isError,true);assert.deepEqual(JSON.parse(mcp.content[0].text).result,evidence);const denied=await client.callTool({name:'runtime_read',arguments:{operation:'lifecycle.extension.evidence.read',projectId:'beta',input:{stageRequestId:id}}});assert.equal(denied.isError,true);
  const candidate=await call('lifecycle.stage.request',{instanceId:'instance',stageId:'candidate'},true),candidateId=candidate.result.stageRequestId;await wait(candidateId,'RUNNING');await call('lifecycle.stage.advance',{stageRequestId:candidateId},true);await wait(candidateId,'COMPLETE');const saved=(await call('lifecycle.instance.inspect',{instanceId:'instance'})).instance;assert.equal(saved.stages['project.prepare'].attempts,1);assert.equal(saved.stages.candidate.attempts,1);assert.equal(saved.candidate.sourceDigest,ciSourceDigest({commit:'c'.repeat(40)},'github','42'));assert.equal(f.calls.filter(c=>c.operation==='ci.dispatch').length,2);
 }finally{await client.close();await server?.close();f.cleanup();}
});

test('sequential preparation stages consume their exact preceding source and retain both original proofs',async()=>{
 const f=await fixture({preparing:true,preparationGraph:'serial'});try{
  f.controls.preparedCommits={'project.prepare':'c'.repeat(40),'project.prepare-second':'d'.repeat(40)};
  await f.prepare('project.prepare');await f.dispatch();f.complete(await f.advance());const first=completedPreparationSource(f.store,f.instance,'project.prepare');f.restart();
  await f.prepare('project.prepare-second');assert.deepEqual(f.request.plan.parameters.source,first.output);assert.equal(f.request.plan.parameters.preparation.input.baselineCommit,'a'.repeat(40));assert.equal(f.request.plan.parameters.preparation.input.parentCommit,'c'.repeat(40));await f.dispatch();f.complete(await f.advance());const second=completedPreparationSource(f.store,f.instance,'project.prepare-second');assert.deepEqual(second.input,first.output);assert.equal(second.output.commit,'d'.repeat(40));
  f.restart();await f.prepare('candidate');assert.deepEqual(f.request.plan.parameters.source,second.output);await f.dispatch();const outcome=await f.advance();assert.equal(outcome.phase,'COMPLETE');assert.equal(outcome.outcome.candidate.sourceDigest,ciSourceDigest({commit:'d'.repeat(40)},'github','42'));assert.equal(f.calls.filter(c=>c.operation==='ci.dispatch').length,3);assert.equal(f.calls.filter(c=>c.operation==='native.package.validate').length,6);assert.deepEqual(completedPreparationSource(f.store,f.instance,'project.prepare'),first);
 }finally{f.cleanup();}
});
for(const reverse of [false,true])test('equal parallel preparations join both source proofs regardless of completion order '+reverse,async()=>{
 const f=await fixture({preparing:true,preparationGraph:'parallel'});try{
  const order=['project.prepare','project.prepare-second'];if(reverse)order.reverse();const proofs=[];
  for(const id of order){await f.prepare(id);assert.equal(f.request.plan.parameters.commit,'b'.repeat(40));assert.equal(f.request.plan.parameters.preparation.input.parentCommit,'b'.repeat(40));await f.dispatch();f.complete(await f.advance());proofs.push(completedPreparationSource(f.store,f.instance,id));}
  f.restart();await f.prepare('candidate');const source=f.request.plan.parameters.source;assert.equal(source.commit,'c'.repeat(40));assert(proofs.every(p=>p.output.evidenceRef!==source.evidenceRef));const expected=resolvePreparationLineage(f.instance.definition.nodes,'candidate',{commit:f.controls.sourceCommit,evidenceRef:f.controls.sourceRef},id=>completedPreparationSource(f.store,f.instance,id));assert.deepEqual(source,expected);await f.dispatch();assert.equal((await f.advance()).phase,'COMPLETE');assert.equal(f.calls.filter(c=>c.operation==='ci.dispatch').length,3);
 }finally{f.cleanup();}
});
test('divergent parallel prepared sources block candidate without selecting the last completed branch',async()=>{
 const f=await fixture({preparing:true,preparationGraph:'parallel'});try{
  f.controls.preparedCommits={'project.prepare':'c'.repeat(40),'project.prepare-second':'d'.repeat(40)};
  for(const id of ['project.prepare','project.prepare-second']){await f.prepare(id);assert.equal(f.request.plan.parameters.commit,'b'.repeat(40));await f.dispatch();f.complete(await f.advance());}
  f.restart();await assert.rejects(()=>f.prepare('candidate'),{code:'CI_PREPARATION_CONFLICT'});assert.equal(f.calls.filter(c=>c.operation==='ci.dispatch').length,2);assert.equal(f.instance.candidate,null);
 }finally{f.cleanup();}
});
for(const kind of ['ontology','harness'])test('preparation rejects self-consistent native action for different source facts: '+kind,async()=>{
 const f=await fixture({preparing:true});try{
  await f.prepare('project.prepare');await f.dispatch();f.complete(await f.advance());const action=f.store.object('alpha','stage-native-action',f.request.id+':'+kind);
  if(kind==='ontology'){action.context.sourceScopeDigest=valueDigest('other-source');action.request.input.context=action.context;}else{action.request.input.observation.values.runtimePreparation.verifiedSource.source.commit='f'.repeat(40);action.observationDigest=nativeSha256(action.request.input.observation);}
  action.requestDigest=ownerRequestDigest(kind,action.request);const{digest,...body}=action;action.digest=valueDigest(body);
  f.store.mutate(f.actor,{projectId:'alpha',operation:'synthetic.fault',requestId:'native-source-corruption',expectedRevision:f.store.revision('alpha'),input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'stage-native-action',id:f.request.id+':'+kind,value:action}],value:{synthetic:true},event:{type:'synthetic-fault',data:{synthetic:true}}}));
  assert.throws(()=>readCiPreparationEvidence(f.store,f.request),{code:'CORRUPT_CI_PREPARATION'});await assert.rejects(()=>f.inspect(),{code:'CORRUPT_CI_PREPARATION'});assert.equal(f.calls.filter(c=>c.operation==='native.package.validate').length,2);
 }finally{f.cleanup();}
});

// Synthetic protected-state setup exercises the production native CI adapter,
// correction capture and real RuntimeStore CAS. Owner responses are synthetic;
// this is neither an installed-owner campaign nor a native authority review.
async function comparisonFixture({originalCiFailure=false,largeInput=false}={}){
  const f=await fixture({repairComparison:true});let serial=0;
  const rootRef='recovery-root:'+valueDigest('synthetic repair root'),rootBody={schema:'runtime-recovery-lineage-root/v1',ref:rootRef,workspaceId:'test',projectId:'alpha',originalInstanceId:'instance',deadlineAt:new Date(Date.now()+120000).toISOString()},root={...rootBody,digest:valueDigest(rootBody)};
  function put(objects,event={type:'synthetic-repair-fixture',data:{}}){return f.store.mutate(f.actor,{projectId:'alpha',operation:'synthetic.repair.fixture',requestId:'synthetic-repair-'+(++serial),expectedRevision:f.store.revision('alpha'),input:{synthetic:true},permission:'read'},()=>({objects,value:{synthetic:true},event}));}
  function ledger(extra=[]){const old=f.store.object('alpha','lifecycle-recovery-ledger','attempts:'+rootRef),body={schema:'runtime-recovery-attempts/v1',rootRef,rootDigest:root.digest,entries:[...(old?.entries??[]),...extra]};return{kind:'lifecycle-recovery-ledger',id:'attempts:'+rootRef,value:{...body,digest:valueDigest(body)}};}
  function member(){
    const i=f.instance,body={schema:'runtime-authority-decision/v1',kind:'execution',workspaceId:'test',projectId:'alpha',subject:{instanceId:i.id,...(i.id==='instance'?{}:{recoveryRootRef:rootRef,recoveryRootDigest:root.digest})}},ref='authority:'+valueDigest(body),objects=[{kind:'authority-decision',id:ref,value:{...body,ref}},{kind:'lifecycle-instance',id:i.id,value:i},{kind:'instance-authority',id:i.id,value:{evidenceRef:ref,recoveryRootRef:rootRef,recoveryRootDigest:root.digest}},{kind:'lifecycle-recovery-ledger',id:'member:'+i.id,value:{schema:'runtime-recovery-member/v1',instanceId:i.id,pinsDigest:i.pinsDigest,authorityRef:ref,rootRef,rootDigest:root.digest}}],entries=[];
    for(const stageId of ['scope','plan','implementation']){const st=i.stages[stageId],plan={adapterId:'synthetic',adapterDigest:valueDigest('synthetic'),action:'base.'+stageId,bindingDigest:valueDigest({}),parameters:{}},rbody={schema:'runtime-stage-request/v1',id:st.requestId,workspaceId:'test',projectId:'alpha',instanceId:i.id,stageId,pinsDigest:i.pinsDigest,inputDigest:st.inputDigest,bindingStamp:valueDigest('synthetic'),authorityRef:f.authority.evidenceRef,releaseAuthorityRef:null,initiatedBy:{id:f.actor.id,revision:1},plan,planDigest:valueDigest(plan),requestedAt:new Date().toISOString(),deadlineAt:root.deadlineAt},r={...rbody,digest:valueDigest(rbody)};
      objects.push({kind:'stage-request',id:r.id,value:r});entries.push({instanceId:i.id,stageId,requestId:r.id,requestDigest:r.digest,deadlineAt:r.deadlineAt});
    }
    put([...objects,ledger(entries)]);
  }
  put([{kind:'lifecycle-recovery-ledger',id:rootRef,value:root}]);member();
  async function start(stage,correctionRef){const r=await f.prepare(stage,correctionRef);if(correctionRef)f.controls.beforeCapture?.(r);const capture=correctionRef?prepareNativeRepairCapture(f.store,f.actor,correctionRef,r):null,p={requestId:r.id,phase:'DISPATCHING',terminal:false,handle:null,observation:null,observationRef:null,reason:null,observedAt:r.requestedAt};put([{kind:'stage-request',id:r.id,value:r},{kind:'stage-progress',id:r.id,value:p},{kind:'lifecycle-instance',id:f.instance.id,value:f.instance},ledger([{instanceId:r.instanceId,stageId:r.stageId,requestId:r.id,requestDigest:r.digest,deadlineAt:r.deadlineAt}]),...(capture?[capture]:[])]);return f.dispatch();}
  function finish(o){const r=f.request,envelope={schema:'runtime-stage-observation/v1',requestId:r.id,observation:o,reason:null,observedAt:new Date().toISOString()},observationRef=valueDigest(envelope),rounds=completeNativeRepairCapture(f.store,r,o,observationRef,envelope.observedAt);f.complete(o);put([{kind:'lifecycle-instance',id:f.instance.id,value:f.instance},{kind:'stage-observation',id:observationRef,value:envelope},{kind:'stage-progress',id:r.id,value:{requestId:r.id,phase:o.phase,terminal:true,handle:o.handle,observation:o,observationRef,reason:null,observedAt:envelope.observedAt}},...rounds],{type:'stage-observed',data:{instanceId:r.instanceId,stageId:r.stageId,stageRequestId:r.id,phase:o.phase,observationRef}});}
  await start('candidate');finish(await f.advance());if(originalCiFailure)f.controls.status='FAILED';if(largeInput)f.controls.extraObservation='x'.repeat(160000);const originalDispatch=await start('verification');f.controls.actualFailure=true;finish(originalCiFailure?originalDispatch:await f.advance());f.controls.status='PASSED';const original=f.request;
  function next(id='successor'){
    const a={...f.authority,instanceId:id};let i=pinInstance(id,a.definitionRevisionId,f.definition,a);
    for(const stage of ['scope','plan','implementation']){i=requestStage(i,stage,'synthetic-'+id+'-'+stage,{authority:a,bindingsCurrent:true});i=recordStageOutcome(i,stage,{requestId:i.stages[stage].requestId,inputDigest:i.stages[stage].inputDigest,receiptRef:'synthetic:predecessor',status:'COMPLETE',expiresAt:root.deadlineAt,checks:f.definition.nodes.find(n=>n.id===stage).checks.map(id=>({id,status:'PASS',evidenceRef:'synthetic:check'}))});}
    f.setInstance(i,a);f.controls.commit='b'.repeat(40);f.controls.sourceCommit=f.controls.commit;f.controls.actualFailure=false;member();
    const service=createCorrectionService(f.store,{original:(_a,p,id)=>({request:f.store.object(p,'stage-request',id),progress:f.store.object(p,'stage-progress',id)}),stageAdmission:async()=>({allowed:false})});
    const proposal=service.write(f.actor,'alpha','lifecycle.correction.propose',{stageRequestId:original.id,hypothesis:'Synthetic candidate repair, not source causality',minimalVerification:'Run the existing candidate checks and the exact comparison policy',proposedChanges:[],verification:{instanceId:id,stageId:'candidate'}},'propose-'+id,f.store.revision('alpha'),()=>f.actor);return proposal.result.correctionRef;
  }
  async function facts(){const plan=await f.adapter.prepare(f.instance,'verification',f.actor,f.signal()),origins=readRecoveryFailureOrigins(f.store,'alpha',f.instance.id,'verification'),subject={schema:'runtime-stage-repair-subject/v2',workspaceId:'test',projectId:'alpha',instanceId:f.instance.id,stageId:'verification',pinsDigest:f.instance.pinsDigest,authorityDigest:f.instance.pins.authorityDigest,candidateDigest:f.instance.candidateDigest,history:origins.map(o=>({request:o.request,progress:o.progress})),preparedPlan:plan,root:{ref:rootRef,digest:root.digest},origins};return f.adapter.verifyRepair(subject,f.actor,f.signal());}
  return{...f,start,finish,next,facts,original,root,put,get instance(){return f.instance;},get request(){return f.request;},get adapter(){return f.adapter;},get store(){return f.store;}};
}
for(const transient of [false,true])test('protected candidate comparison proves each original actual product failure before '+(transient?'policy-classified transient':'deterministic')+' retry',async()=>{
  const f=await comparisonFixture();try{const ref=f.next();if(transient)f.controls.comparison={transient:'PASS'};await f.start('candidate',ref);const result=await f.advance();assert.equal(result.phase,'COMPLETE');f.finish(result);const facts=await f.facts();assert.equal(facts.schema,'runtime-stage-repair-facts/v2');assert.equal(facts.failureClass,transient?'TRANSIENT':'DETERMINISTIC');assert.equal(facts.origins.length,1);assert.equal(facts.origins[0].requestId,f.original.id);assert.equal(facts.origins[0].failedCriteria[0].variantId,'actual-observation');assert.equal(f.store.object('alpha','stage-progress',f.original.id).phase,'FAILED');assert.equal(f.calls.filter(c=>c.request?.input.id==='synthetic-comparison').length,1);assert.equal(facts.after.candidateDigest,f.instance.candidateDigest);}finally{f.cleanup();}
});
test('comparison failure retains actual candidate PASS but cannot establish repair',async()=>{
  const f=await comparisonFixture();try{const ref=f.next();f.controls.comparison={comparable:'FAIL',regression:'FAIL'};await f.start('candidate',ref);const result=await f.advance();assert.equal(result.phase,'COMPLETE');f.finish(result);assert.equal(f.instance.stages.candidate.status,'PASSED');assert.equal(await f.facts(),null);assert.equal(f.store.object('alpha','lifecycle-recovery-ledger','repair-round:'+f.request.id).outcome,'PASS');}finally{f.cleanup();}
});
test('comparison cannot replace product actual FAIL and failed probe retains its available evidence',async()=>{
  const f=await comparisonFixture();try{const ref=f.next();f.controls.actualFailure=true;await f.start('candidate',ref);const result=await f.advance();assert.equal(result.phase,'FAILED');f.finish(result);const round=f.store.object('alpha','lifecycle-recovery-ledger','repair-round:'+f.request.id);assert.equal(round.outcome,'FAIL');assert.equal(round.candidateEvidence.candidate,null);assert(round.candidateEvidence.comparison);assert.equal(f.instance.candidate,null);}finally{f.cleanup();}
});
test('lost comparison response is observed from its original receipt without repeating native validation',async()=>{
  const f=await comparisonFixture();try{const ref=f.next();await f.start('candidate',ref);f.controls.comparisonLost=true;await assert.rejects(()=>f.advance(),{code:'SYNTHETIC_RESPONSE_LOST'});f.restart();f.controls.comparisonLost=false;const result=await f.inspect();assert.equal(result.phase,'COMPLETE');f.finish(result);assert.equal(f.calls.filter(c=>c.request?.input.id==='synthetic-comparison').length,1);assert(await f.facts());}finally{f.cleanup();}
});
test('CI failure before native actions retains an unavailable comparison round without fabricating a candidate',async()=>{
  const f=await comparisonFixture();try{const ref=f.next();f.controls.status='FAILED';const result=await f.start('candidate',ref);assert.equal(result.phase,'FAILED');f.finish(result);const round=f.store.object('alpha','lifecycle-recovery-ledger','repair-round:'+f.request.id);assert.deepEqual(round.candidateEvidence,{ci:null,product:null,comparison:null,candidate:null});assert.equal(round.nativeActionDigest,null);assert.equal(f.calls.filter(c=>c.request?.input.id==='synthetic-comparison').length,0);}finally{f.cleanup();}
});

test('one actual candidate comparison covers every retained origin rather than only the latest failed candidate',async()=>{
 const f=await comparisonFixture();try{
  await f.start('candidate',f.next());f.finish(await f.advance());await f.start('verification');f.controls.actualFailure=true;f.finish(await f.advance());const second=f.request;
  await f.start('candidate',f.next('third'));f.finish(await f.advance());const facts=await f.facts();assert.equal(facts.origins.length,2);assert.deepEqual(new Set(facts.origins.map(o=>o.requestId)),new Set([f.original.id,second.id]));assert.equal(new Set(facts.origins.flatMap(o=>o.coverage.map(c=>c.comparisonReceiptDigest))).size,1);
  const call=f.calls.filter(c=>c.request?.input.id==='synthetic-comparison').at(-1);assert.equal(call.request.input.observation.values.runtimeRepairComparison.origins.length,2);assert.equal(f.store.object('alpha','stage-progress',second.id).phase,'FAILED');
 }finally{f.cleanup();}
});
test('a protected candidate identity mismatch cannot be hidden by a comparison PASS',async()=>{
 const f=await comparisonFixture();try{await f.start('candidate',f.next());f.finish(await f.advance());const id='repair-round:'+f.request.id,mutated=structuredClone(f.store.object('alpha','lifecycle-recovery-ledger',id));mutated.candidateEvidence.candidate.manifestDigest=valueDigest('wrong candidate');delete mutated.digest;mutated.digest=valueDigest(mutated);f.put([{kind:'lifecycle-recovery-ledger',id,value:mutated}]);await assert.rejects(()=>f.facts(),{code:'REPAIR_CANDIDATE_CHANGED'});}finally{f.cleanup();}
});
test('two completed comparable policy rounds with no progress stop another associated candidate probe',async()=>{
 const f=await comparisonFixture();try{
  f.controls.comparison={comparable:'PASS',regression:'FAIL',progress:'FAIL'};
  await f.start('candidate',f.next());f.finish(await f.advance());await f.start('candidate',f.next('third'));f.finish(await f.advance());const ref=f.next('fourth'),count=f.calls.filter(c=>c.operation==='native.package.validate').length;
  await assert.rejects(()=>f.start('candidate',ref),{code:'TWO_NO_PROGRESS_ROUNDS'});assert.equal(f.calls.filter(c=>c.operation==='native.package.validate').length,count);
 }finally{f.cleanup();}
});
test('a completed candidate cannot acquire a repair association or comparison action retrospectively',async()=>{
 const f=await comparisonFixture();try{const ref=f.next();await f.start('candidate');f.finish(await f.advance());assert.throws(()=>prepareNativeRepairCapture(f.store,f.actor,ref,{...f.request,correctionRef:ref}),{code:'REPAIR_PREBIND_REQUIRED'});assert.equal(f.store.object('alpha','lifecycle-recovery-ledger','comparison-action:'+f.request.id),null);}finally{f.cleanup();}
});

test('private historical origins are rejected before a public successor comparison can receive any input',async()=>{
 const f=await comparisonFixture();try{const ref=f.next(),before=f.calls.filter(c=>c.operation==='native.package.validate').length;
  f.controls.beforeCapture=r=>{r.plan=structuredClone(r.plan);for(const pin of [r.plan.parameters.owners.harness,r.plan.parameters.repairComparison.owner]){pin.scope.visibility='public';pin.reference.visibility='public';}r.plan.bindingDigest=valueDigest(r.plan.parameters);r.planDigest=valueDigest(r.plan);const{digest,...body}=r;r.digest=valueDigest(body);};
  await assert.rejects(()=>f.start('candidate',ref),{code:'REPAIR_POLICY_SCOPE'});assert.equal(f.calls.filter(c=>c.operation==='native.package.validate').length,before);assert.equal(f.store.object('alpha','stage-request',f.request.id),null);
 }finally{f.cleanup();}
});
test('original CI failure without native product evidence is rejected before a repair candidate request',async()=>{
 const f=await comparisonFixture({originalCiFailure:true});try{const ref=f.next(),before=f.calls.length;await assert.rejects(()=>f.start('candidate',ref),{code:'REPAIR_ORIGIN_UNPROVEN'});assert.equal(f.calls.slice(before).some(c=>['native.package.validate','ci.dispatch'].includes(c.operation)),false);assert.equal(f.store.object('alpha','stage-request',f.request.id),null);}finally{f.cleanup();}
});
test('oversized combined comparison becomes explicit unavailable without erasing candidate product PASS',async()=>{
 const f=await comparisonFixture({largeInput:true});try{await f.start('candidate',f.next());const result=await f.advance();assert.equal(result.phase,'COMPLETE');f.finish(result);assert.equal(f.instance.stages.candidate.status,'PASSED');assert.equal(f.store.object('alpha','lifecycle-recovery-ledger','comparison-unavailable:'+f.request.id).reason,'REPAIR_COMPARISON_LIMIT');assert.equal(f.store.object('alpha','lifecycle-recovery-ledger','repair-round:'+f.request.id).candidateEvidence.comparisonUnavailable.reason,'REPAIR_COMPARISON_LIMIT');assert.equal(f.calls.filter(c=>c.request?.input.id==='synthetic-comparison').length,0);assert.equal(await f.facts(),null);}finally{f.cleanup();}
});
test('refreshing policy registration metadata cannot reset the two completed no-progress rounds',async()=>{
 const f=await comparisonFixture();try{f.controls.comparison={comparable:'PASS',regression:'FAIL',progress:'FAIL'};await f.start('candidate',f.next());f.finish(await f.advance());const policy=f.config.resources.find(r=>r.role==='config.verification.failurePolicyRef');policy.revision++;policy.expiresAt='2031-01-01T00:00:00Z';f.save();await f.start('candidate',f.next('third'));f.finish(await f.advance());const ref=f.next('fourth'),calls=f.calls.length;await assert.rejects(()=>f.start('candidate',ref),{code:'TWO_NO_PROGRESS_ROUNDS'});assert.equal(f.calls.slice(calls).some(c=>['native.package.validate','ci.dispatch'].includes(c.operation)),false);}finally{f.cleanup();}
});
