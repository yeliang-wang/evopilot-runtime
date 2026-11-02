// Isolated synthetic asset preparation using published owner APIs only.
// The test attestations below never represent a real user's domain approval.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyOwnerDistribution } from '../../dist/adapters/published-owners.js';
import { createRuntimeService } from '../../dist/service.js';
import { nativeSha256 } from '../../vendor/compatibility/v1/native.mjs';
import { READINESS_STANDARD_DIGEST, READINESS_SPEC_PATH, readinessCriteria, validateReadinessSpecification } from '../../vendor/compatibility/usability/v2/contract.mjs';
import { lifecycle, setPath } from './lifecycle-v090.mjs';
import { loadPublisherBase } from '../../dist/lifecycle/base.js';
import { compileLifecycle } from '../../dist/lifecycle/compiler.js';
import { stringify } from 'yaml';

const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
export function syntheticReadinessMaterial(workspaceId='runtime-adapter-fixture',projectId='synthetic'){
  const scope={visibility:'private',projectId},path='readiness/contract.md';
  const text='Synthetic adapter fixture only. The project has an identifier and two capabilities. A read accepts its exact project identifier and returns that same identifier. Unknown identifiers fail. The read creates no side effects, is idempotent and safe to repeat concurrently. It needs no external database, network or reconstruction. This declared fixture is not DataRig or EvoPilot business acceptance.\n';
  const definition={schema:'evopilot-modeling-intent/v2',standardVersion:'v2',standardDigest:READINESS_STANDARD_DIGEST,workspaceId,scope,id:'synthetic-content',mode:'DOCUMENT_FORWARD',purpose:'Exercise current published owner readiness adapters using explicit synthetic data.',functionalScope:'Synthetic read-only project identity contract only.',exclusions:['Real business assets','Production infrastructure','Generated software equivalence'],targetLevel:'L3',sources:[{id:'fixture-design',kind:'DOCUMENT',reference:'synthetic://runtime-adapter/contract',revision:'1',digest:digest(text)}],requirements:[{id:'project',kind:'DOMAIN',description:'Synthetic project identity and two declared capabilities.',acceptance:'The fixture projection retains the exact synthetic identity.',sourceIds:['fixture-design'],excludedFacets:[]},{id:'inspect',kind:'BEHAVIOR',description:'Read the synthetic project identity without side effects.',acceptance:'Read matches its identifier; unknown identity fails; no external operations.',sourceIds:['fixture-design'],excludedFacets:[]}],userIntentOrigin:'explicit-request'};
  const intentDigest=nativeSha256(definition),citation={path,contentDigest:digest(text),locator:'line:1'};
  const specification=validateReadinessSpecification({schema:'evopilot-readiness-specification/v2',standardVersion:'v2',standardDigest:READINESS_STANDARD_DIGEST,intentDigest,intent:definition,author:'synthetic-adapter-fixture',statements:readinessCriteria(definition).map(criterionId=>({criterionId,text:'Synthetic declared criterion '+criterionId+': '+text.trim(),status:'RESOLVED',provenance:[{kind:'DESIGN_DECLARATION',sourceId:'fixture-design',locator:'line:1',resolutionReference:null}],citations:[citation]})),dependencies:[],normativeFiles:[{path,digest:digest(text)}]});
  return{definition,intentDigest,specification,citation,files:{[path]:text,[READINESS_SPEC_PATH]:JSON.stringify(specification)}};
}

// Explicit complete example configuration for admission testing. All policy
// choices are visible data. This helper never approves execution, emits PASS
// evidence or creates credentials for a real project.
export function lifecycleBindingExample({root,workspaceId,projectId,platform,credential,ownerRegistrations,references,assessmentId,evidenceOrigin='SYNTHETIC',ontologySemanticId='https://example.invalid/r1/project',harnessRule='H001',harnessVariant='positive',harnessRequirements=[{ruleId:harnessRule,variantIds:[harnessVariant]}],agentExecutable=process.execPath,agentVersion='synthetic-unexecuted'}){
  const data=lifecycle(platform.provider,projectId),platformRef=platform.ref,location={kind:'location',directory:root,purpose:'Isolated lifecycle test preparation'},review={kind:'review',reviewerIds:['fixture'],evidenceRequired:true},recovery={kind:'recovery',strategy:'inspect-original',onUnknown:'BLOCK',maxAttempts:1};
  for(const key of ['provider','host','repository','repositoryId','defaultBranch','credentialRef','workflowPath','pipelinePath','runner']){if(platform[key]!==undefined)data.config.implementation[key]=platform[key];else delete data.config.implementation[key];}
  data.config.publication.credentialRef=credential.ref;data.config.closure.deliveryMode='distribution';
  const documentPath=join(root,'target.md');writeFileSync(documentPath,'Synthetic bounded fixture target. No business or release authority.\n',{mode:0o600});
  const executable={path:agentExecutable,digest:digest(readFileSync(agentExecutable))};
  const definitions={
    'config.scope.targetInputRef':{kind:'document',file:{path:documentPath,digest:digest(readFileSync(documentPath))},format:'markdown'},
    'config.scope.baselineRuleRef':{kind:'baseline',branch:platform.defaultBranch,changeMode:'pull-request',requireClean:true,exactSource:true},
    'config.scope.requirementsMappingRef':{kind:'requirements-map',...references,rows:harnessRequirements.map((r,i)=>({id:'synthetic-requirement-'+i,semanticId:ontologySemanticId,...r}))},
    'config.scope.deliveryTargetRef':{kind:'delivery',mode:'distribution',platformRef},
    'config.plan.planLocationRef':location,'config.plan.adrLocationRef':location,
    'config.plan.compatibilityPolicyRef':{kind:'compatibility',strategy:'exact-pins',allowUnreviewedDrift:false},
    'config.plan.reviewPolicyRef':review,'config.plan.recoveryPolicyRef':recovery,'config.implementation.reviewPolicyRef':review,
    'config.implementation.agentBindingRef':{kind:'agent',adapter:'codex',executable,version:agentVersion,hostId:'synthetic-fixture-host',workspaceRoot:root},
    'config.candidate.buildWorkflowRef':{kind:'workflow',platformRef,purpose:'build',outputContract:'runtime-ci/v1'},
    'config.candidate.toolchainRef':{kind:'toolchain',executables:[{file:{path:process.execPath,digest:digest(readFileSync(process.execPath))},version:process.version}]},
    'config.candidate.artifactLocationRef':{kind:'artifact-store',platformRef,retentionDays:data.config.candidate.retentionDays},
    'config.candidate.manifestActionRef':{kind:'manifest',action:'runtime.candidate.manifest/v1'},
    'config.verification.environmentRef':{kind:'environment',platformRef,scope:'dedicated-test',maxConcurrency:data.config.verification.budget.maxConcurrency},
    'config.verification.verifyWorkflowRef':{kind:'workflow',platformRef,purpose:'verify',outputContract:'runtime-ci/v1'},
    'config.verification.failurePolicyRef':{kind:'failure',onFailure:'BLOCK',onUnknown:'BLOCK'},
    'config.release-decision.authorityPolicyRef':{kind:'authority-policy',principalIds:['fixture'],exactSubjectRequired:true},
    'config.release-decision.decisionSourceRef':{kind:'decision-source',backend:'runtime',decisionTypes:['execution','release']},
    'config.release-decision.evidencePolicyRef':{kind:'evidence-policy',requireAll:true,requireCurrent:true,allowSkipped:false},
    'config.publication.channelTargetRef':{kind:'channel',platformRef,channel:data.config.publication.channel},
    'config.publication.publishWorkflowRef':{kind:'workflow',platformRef,purpose:'publish',outputContract:'runtime-ci/v1'},
    'config.publication.readbackPolicyRef':{kind:'readback',verifyDownloadedDigests:true,requireExactCandidate:true},
    'config.publication.recoveryPolicyRef':recovery,
    'config.closure.deliveryTargetRef':{kind:'delivery',mode:'distribution',platformRef},
    'config.closure.smokeWorkflowRef':{kind:'workflow',platformRef,purpose:'smoke',outputContract:'runtime-ci/v1'},
    'config.closure.archiveRef':location,'config.closure.followupPolicyRef':{kind:'followup',onGap:'create-target',autoExecute:false},
  };
  const check={kind:'check',owner:'harness',criterionId:harnessRule,variantIds:[harnessVariant]};
  for(const owner of ['ontology','harness']){
    const reference=references[owner];data.assets[owner]={...data.assets[owner],adapterRef:ownerRegistrations.find(o=>o.owner===owner).ref,projectId,visibility:reference.visibility,id:reference.id,version:reference.version,digest:reference.digest,targetLevel:'L3'};
    definitions['assets.'+owner+'.mappingRef']={kind:'asset-map',owner,reference,assessmentId:owner==='ontology'?assessmentId:null,evidenceOrigin};
    definitions['assets.'+owner+'.standardRef']={kind:'standard',owner,standardDigest:reference.standardDigest,standardLockDigest:reference.standardLockDigest,contractDigest:reference.contractDigest,readinessStandardDigest:READINESS_STANDARD_DIGEST};
  }
  for(const stage of ['plan','implementation','verification','release-decision','closure'])definitions['config.'+stage+'.requiredChecks']=check;
  const compilation=compileLifecycle(stringify(data),projectId),effective=compilation.effective;assert(effective,JSON.stringify(compilation.issues));
  definitions['config.verification.evidenceMappingRef']={kind:'evidence-map',...references,rows:effective.nodes.flatMap(node=>node.checks.map(checkId=>({stage:node.id,checkId,owner:'harness',criterionId:harnessRule,variantIds:[harnessVariant],source:'owner-receipt'})))};
  const resources=[];
  for(const field of loadPublisherBase().base.fields){
    if(!field.providers.includes(platform.provider)||!['bindingRef','bindingList'].includes(field.type)||field.path.endsWith('.adapterRef'))continue;
    const definition=definitions[field.path];assert(definition,'Missing explicit example resource '+field.path);
    const parts=field.path.split('.');let value=data;for(const part of parts)value=value[part];
    for(const ref of Array.isArray(value)?value:[value])resources.push({ref,workspaceId,projectId,role:field.path,revision:1,expiresAt:platform.expiresAt,definition:structuredClone(definition)});
  }
  return{data,configuration:{schema:'runtime-integrations/v1',workspaceId,revision:1,platforms:[platform],credentials:[credential],owners:ownerRegistrations,resources}};
}
// Fixture shape follows the published native package contract and reads the
// standard's shipped positive/negative example material, not sibling source.
export function syntheticOntologyPackage(root,standard){
  const source=path=>readFileSync(join(root,'specifications/v1/examples/positive',path),'utf8');
  const namespace='https://example.invalid/r1/',model=source('model.ttl'),data=source('data.ttl'),shapes=source('shapes.ttl');
  const names=['ProjectShape','CapabilitiesShape','CapabilityShape','KindShape','OperationShape','LimitShape'];
  const negatives=[['root-type','ProjectShape',data.replace('ex:project a ex:Project','ex:project a ex:Other')],['relation','CapabilitiesShape',data.replace('ex:hasCapability ex:engine, ex:query','ex:hasCapability ex:engine')],['combination','CapabilityShape',data.replace('ex:operation "execute"','ex:operation "search"')],['kind','KindShape',data.replace('; ex:kind "ENGINE"','')],['operation','OperationShape',data.replace('; ex:operation "execute"','')],['limit','LimitShape',data.replace('; ex:limit 3','')]];
  const cases=[{id:'positive',data:'tests/positive.ttl',expectedConforms:true,requirementIds:['scope'],shapeIds:names.map(n=>namespace+n)},...negatives.map(([id,shape])=>({id,data:'tests/'+id+'.ttl',expectedConforms:false,requirementIds:['scope'],shapeIds:[namespace+shape]}))];
  const content=model+data;
  const files={
    'model.ttl':model,'shapes/domain.ttl':shapes,'instances/current.ttl':data,'sources/source.txt':content,
    'scope/coverage.json':JSON.stringify({schema:'evopilot-ontology-coverage/v1',namespace,projectRoot:namespace+'project',expectedEntities:[{id:namespace+'project',type:namespace+'Project'},{id:namespace+'engine',type:namespace+'Capability'},{id:namespace+'query',type:namespace+'Capability'}],requiredShapeIds:names.map(n=>namespace+n),requiredCaseIds:cases.map(c=>c.id)}),
    'sources/bindings.json':JSON.stringify({schema:'evopilot-source-bindings/v1',direction:'reverse',sources:[{id:'source',locator:'synthetic://published-standard-example',revision:'fixture-1',digest:digest(content),status:'observed',visibility:'private',contentPath:'sources/source.txt'}],requirements:[{id:'scope',required:true,disposition:'covered'}],mappings:['Project','Capability','hasCapability',...names].map(n=>({requirementId:'scope',targetId:namespace+n,sourceId:'source',status:'observed',revision:'fixture-1',fileDigest:digest(content),selector:{kind:'lines',start:1,end:content.split('\n').length},fragmentDigest:digest(content)}))}),
    'tests/cases.json':JSON.stringify({schema:'evopilot-ontology-cases/v1',cases}),'tests/positive.ttl':data,...Object.fromEntries(negatives.map(([id,,text])=>['tests/'+id+'.ttl',text])),
  };
  return{manifest:{schema:'evopilot-native-package/v1',specVersion:'v1',owner:'ontology',id:'runtime-synthetic-model',version:'1.0.0',visibility:'private',standardPins:{standardDigest:standard.standardDigest,standardLockDigest:standard.standardLockDigest},contractDigest:standard.contractDigest,producer:{product:'ontology',version:'0.3.0'},entrypoints:{model:'model.ttl',shapes:['shapes/domain.ttl'],instances:['instances/current.ttl'],coverage:'scope/coverage.json',cases:'tests/cases.json'},files:Object.entries(files).sort(([a],[b])=>a.localeCompare(b,'en')).map(([path,text])=>({path,mediaType:path.endsWith('.ttl')?'text/turtle':path.endsWith('.txt')?'text/plain':'application/json',sha256:digest(text).slice(7)})),dependencies:[],sourceBindingRef:'sources/bindings.json'},files};
}

export async function preparePublishedOwnerFixtures({packageRoots,evidenceRoot,workspaceId='runtime-adapter-fixture',projectId='synthetic',toolchain,withReadiness=false,createHarnessFixture}){
  assert(toolchain,'An explicitly selected verified native toolchain is required; no skipped owner validation');
  assert(!existsSync(evidenceRoot),'Fixture preparation must preserve existing attempts; choose a new isolated root');
  for(const owner of ['ontology','harness'])verifyOwnerDistribution(owner,packageRoots[owner]);
  const load=(owner,path)=>import(pathToFileURL(join(packageRoots[owner],path)).href);
  const [ontologyApi,harnessApi,ontologyPure,harnessExamples,authoring,evidence]=await Promise.all([load('ontology','dist/service.js'),load('harness','dist/service.js'),load('ontology','dist/index.js'),load('harness','examples/native/package.mjs'),load('harness','examples/native/authoring.mjs'),load('harness','examples/native/decision-evidence.mjs')]);
  mkdirSync(evidenceRoot,{recursive:true,mode:0o700});const workspaceRoot=join(evidenceRoot,'workspace'),scope={visibility:'private',projectId};
  const options={workspaceRoot,workspaceId},runtime=withReadiness?createRuntimeService(options):null,material=withReadiness?syntheticReadinessMaterial(workspaceId,projectId):null;
  runtime?.initialize();
  let intentRecord=null;
  const ontology=ontologyApi.createOntologyService(options,{nativeToolchain:toolchain,resolveNativeAuthoring:authoring.syntheticAuthoring,...(runtime?{resolveReadinessAuthoring:request=>{assert(intentRecord);assert.equal(request.workspaceId,workspaceId);assert.deepEqual(request.scope,scope);assert.equal(request.intentDigest,intentRecord.digest);return intentRecord;}}:{})});
  ontology.initialize();
  const harness=harnessApi.createHarnessService(options,{nativeToolchain:toolchain,resolveNativeAuthoring:authoring.syntheticAuthoring,...(runtime?{readReadinessIntent:async req=>runtime.readiness({operation:'readiness.intent.read',scope:req.scope,input:{standardVersion:'v2',digest:req.digest}}),readReadinessProjection:async req=>ontology.readiness({operation:'readiness.package.inspect',scope:req.scope,input:{standardVersion:'v2',id:req.reference.id,version:req.reference.version}})}:{}),resolveNativeDependency:async req=>{
    assert.equal(req.workspaceId,workspaceId);assert.deepEqual(req.scope,scope);
    const record=await ontology.native({operation:'native.package.readback',scope,input:{id:req.reference.id,version:req.reference.version}});assert.deepEqual(record.reference,req.reference);return{reference:req.reference,published:true,workspaceId,scope};
  }});harness.initialize();const references={},receipts={};
  try{
    if(material){
      const review=await runtime.readiness({operation:'readiness.intent.review',scope,input:{standardVersion:'v2',definition:material.definition,previousDigest:null}});
      const humanEvidenceRef=evidence.syntheticDecisionEvidence(evidenceRoot,{owner:'runtime',operation:'readiness.intent.record',workspaceId,scope,reviewDigest:review.reviewDigest,decision:'ACCEPT'});
      const request={operation:'readiness.intent.record',scope,input:{standardVersion:'v2',definition:material.definition,previousDigest:null,humanEvidenceRef},requestId:'synthetic-readiness-intent',expectedRevision:(await runtime.readiness({operation:'readiness.inspect',scope,input:{standardVersion:'v2'}})).revision};
      const receipt=await runtime.readiness(request);intentRecord=receipt.result;writeFileSync(join(evidenceRoot,'runtime-readiness-intent.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
    }
    for(const [owner,service] of [['ontology',ontology],['harness',harness]]){
      const write=async(operation,input,requestId)=>{
        const request={operation,scope,input,requestId,expectedRevision:service.execute({operation:'workspace.inspect',scope,input:{}}).revision};
        const receipt=await service.native(request);receipts[owner+'-'+requestId]=receipt;
        writeFileSync(join(evidenceRoot,owner+'-'+requestId+'.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
        if(owner==='harness')assert.equal(receipt.status,'SUCCEEDED');return receipt.result;
      };
      const pkg=owner==='ontology'?syntheticOntologyPackage(packageRoots.ontology,ontologyPure.inspectOntologyStandard()):createHarnessFixture?createHarnessFixture(harnessExamples):harnessExamples.syntheticHarnessPackage({id:'runtime-synthetic-quality'});
      if(owner==='ontology'&&material){Object.assign(pkg.files,material.files);pkg.manifest.files=Object.entries(pkg.files).sort(([a],[b])=>a.localeCompare(b,'en')).map(([path,text])=>({path,mediaType:path.endsWith('.ttl')?'text/turtle':path.endsWith('.json')?'application/json':path.endsWith('.md')?'text/markdown':'text/plain',sha256:digest(text).slice(7)}));}
      if(owner==='harness')pkg.manifest.dependencies=[references.ontology];
      const identity={id:pkg.manifest.id,version:pkg.manifest.version};
      await write('native.package.put',{package:pkg},'put');
      const validation=await write('native.package.validate',identity,'validate');assert.equal(owner==='ontology'?validation.status:validation.qualityStatus,owner==='ontology'?'CONFORMS':'PASS');
      const review=await write('native.package.review',identity,'review');
      const humanEvidenceRef=evidence.syntheticDecisionEvidence(evidenceRoot,{owner,operation:'native.package.decide',workspaceId,scope,reviewDigest:review.reviewDigest,decision:'APPROVE'});
      await write('native.package.decide',{...identity,reviewDigest:review.reviewDigest,decision:'APPROVE',humanEvidenceRef},'synthetic-decision');
      const published=await write('native.package.publish',identity,'publish');references[owner]=published.reference;
      const readback=await service.native({operation:'native.package.readback',scope,input:identity});assert.deepEqual(readback.reference,references[owner]);
    }
    let readiness=null;
    if(material){
      const projection=await ontology.readiness({operation:'readiness.package.inspect',scope,input:{standardVersion:'v2',id:references.ontology.id,version:references.ontology.version}});
      const report={schema:'evopilot-content-review/v2',standardVersion:'v2',intentDigest:material.intentDigest,projectionDigest:projection.digest,actor:'synthetic-adapter-review',origin:'SYNTHETIC',method:'DESIGN_REVIEW',results:readinessCriteria(material.definition).map(criterionId=>({criterionId,verdict:'SUPPORTED',reason:'Synthetic fixture contract exercise only; not a real business/model approval.',citations:[material.citation]}))};
      const write=async(operation,input,requestId)=>{
        const state=await harness.readiness({operation:'readiness.inspect',scope,input:{standardVersion:'v2'}}),receipt=await harness.readiness({operation,scope,input,requestId,expectedRevision:state.revision});
        writeFileSync(join(evidenceRoot,requestId+'.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});return receipt.result;
      };
      const review=await write('readiness.review.record',{standardVersion:'v2',reference:references.ontology,report},'synthetic-content-review');
      const assessmentId='synthetic-content',assessment=await write('readiness.assessment.evaluate',{standardVersion:'v2',id:assessmentId,intentDigest:material.intentDigest,reference:references.ontology,reviewDigest:review.digest,reconstructionEvidenceIds:[]},'synthetic-content-assessment');
      assert.equal(assessment.assetAssessment.status,'QUALIFIED');assert.equal(assessment.assetAssessment.level,'L3');assert.equal(assessment.assetAssessment.evidenceOrigin,'SYNTHETIC');assert.equal(assessment.reconstructionVerification.status,'NOT_REQUESTED');
      readiness={intentDigest:material.intentDigest,assessmentId,projectionDigest:projection.digest,assessmentDigest:assessment.digest,origin:'SYNTHETIC'};
    }
    const result={schema:'runtime-published-owner-fixture/v1',syntheticAssets:true,syntheticDecisions:true,realOwnerPackages:'0.8.3',actualNativeValidation:true,workspaceRoot,workspaceId,scope,packageRoots,references,readiness};
    writeFileSync(join(evidenceRoot,'FIXTURE.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
  }finally{harness.close();ontology.close();runtime?.close();}
}
