import {pathToFileURL as collectorPathToFileURL} from 'node:url';
import {resolve as collectorResolve} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {openScenario,repository,sha} from './support.mjs';

// Real installed package APIs are imported below. Source imports are confined
// to the evidence recorder; no source service, fixture binding provider, owner
// source tree or mocked platform is substituted for the selected distribution.
const read=ref=>JSON.parse(fs.readFileSync(ref));
function privatePinned(value){
 assert.deepEqual(Object.keys(value).sort(),['ref','sha256']);
 assert.equal(fs.realpathSync(value.ref),value.ref);const s=fs.lstatSync(value.ref);
 assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=1048576&&(s.mode&0o077)===0&&s.uid===process.getuid());
 const bytes=fs.readFileSync(value.ref);assert.equal(sha(bytes),value.sha256);return JSON.parse(bytes);
}
const execute=(executable,args,cwd,timeout=60000)=>new Promise(resolve=>execFile(executable,args,{cwd,timeout,maxBuffer:8388608,encoding:'utf8',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME,LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'}},(error,stdout,stderr)=>resolve({executable,args,exitCode:error?error.code:0,signal:error?.signal??null,stdout,stderr})));

export async function executeE08() {
 const run=await openScenario('E08'),root=path.join(run.selection.installedRoot,'package');
 const configuration=run.selection.packageCompatibility;
 assert(configuration,'Select explicit private fixture and static source/navigation inputs for E08');
 assert.deepEqual(Object.keys(configuration).sort(),['fixture','parentNavigationRoot','sourceRevision']);
 const fixture=privatePinned(configuration.fixture);
 assert.equal(fixture.schema,'runtime-published-owner-fixture/v1');
 assert.equal(fixture.syntheticAssets,true);assert.equal(fixture.syntheticDecisions,true);
 assert.equal(fixture.realOwnerPackages,'0.8.3');assert.equal(fixture.actualNativeValidation,true);
 const api=await import(pathToFileURL(path.join(root,'dist/adapters/published-owners.js')).href);
 const guide=await import(pathToFileURL(path.join(root,'dist/host/guide.js')).href);
 const metadata=read(path.join(root,'package.json'));
 assert.equal(metadata.version,run.candidate.version);assert.equal(metadata.name,'@evopilot-next/runtime');
 const versionMatrix={runtime:metadata.version,owners:{}};
 for(const owner of ['ontology','harness'])versionMatrix.owners[owner]=api.verifyOwnerDistribution(owner,fixture.packageRoots[owner]);
 const actor={id:'e08-package-reader',projects:[fixture.scope.projectId],permissions:['read'],revision:1,expiresAt:new Date(Date.now()+3600000).toISOString()};
 const adapters=[];
 async function compatible(){
  const responses=[];
  for(const owner of ['ontology','harness']){
   const identity=api.ownerDistributionIdentity(owner);assert.equal(identity.version,'0.8.3');assert.notEqual(identity.version,metadata.version);
   const adapter=await api.openPublishedOwner({owner,packageRoot:fixture.packageRoots[owner],workspaceRoot:fixture.workspaceRoot,workspaceId:fixture.workspaceId,projects:[fixture.scope.projectId]},undefined,adapters[0]);adapters.push(adapter);
   const call=async(operation,input={})=>{
    const request={operation,scope:fixture.scope,input},response=await adapter.read(actor,fixture.scope.projectId,request);
    run.artifact('owner-api.json',{owner,identity,request,response,actualPublishedApi:true,syntheticAssets:true});return response;
   };
   const before=await call('workspace.inspect');
   const standard=await call('standard.inspect');assert.equal(standard.contractDigest,fixture.references[owner].contractDigest);
   const list=await call('native.package.list');assert(list);
   const reference=fixture.references[owner],pkg=await adapter.readPackage(actor,fixture.scope.projectId,fixture.scope,reference);
   run.artifact('owner-readback.json',{owner,request:{reference,scope:fixture.scope},response:pkg,actualPublishedApi:true});
   assert.deepEqual(pkg.reference,reference);if(owner==='harness')assert.equal(pkg.published,true);
   const inspector=await api.openPublishedOwnerInspectors(owner,fixture.packageRoots[owner]);assert.equal(inspector.standardPins.standardDigest,reference.standardDigest);
   if(owner==='harness'){
    const parameters=inspector.parameters(pkg.package);assert(parameters.effectiveConfigDigest.startsWith('sha256:'));
    run.artifact('harness-package-validation.json',{reference,result:parameters,kind:'ACTUAL_PUBLISHED_PACKAGE_INSPECTOR',nativeValidation:'Separate original fixture validation is retained; this read does not invent a new native receipt'});
   }
   const after=await call('workspace.inspect');assert.equal(after.revision,before.revision);
   assert.equal(adapter.capabilities().authoring,false);assert.equal(adapter.capabilities().assetPublication,false);
   responses.push({owner,identity,reference,stateUnchanged:true});
  }
  const guidance=guide.callGuide({scenario:'asset-consumption'});assert.notEqual(guidance.isError,true);
  assert.equal(guidance.structuredContent.authority,false);assert.equal(guidance.structuredContent.connectionAccessed,false);
  run.artifact('installed-owner-guidance.json',{result:guidance,scope:'Installed read-only guide; actual conversational Host journeys remain E03/E10 obligations'});
  return{versionMatrix,actualPublicOwnerReads:true,exactImmutableAssetReadback:true,realPublicSchemaInspectors:true,syntheticAssets:true,syntheticDecisions:true,ownerWrites:0,responses};
 }
 async function incompatible(){
  const findings=[];
  for(const owner of ['ontology','harness']){
   const original=fixture.packageRoots[owner],copy=path.join(run.selection.outputRoot,'incompatible-'+owner);
   fs.cpSync(original,copy,{recursive:true,force:false,errorOnExist:true,verbatimSymlinks:true});
   const ref=path.join(copy,'package.json'),bytes=fs.readFileSync(ref),pkg=JSON.parse(bytes);
   assert.equal(pkg.version,'0.8.3');pkg.version='0.9.0';fs.writeFileSync(ref,JSON.stringify(pkg,null,2)+'\n');
   let error;try{await api.openPublishedOwner({owner,packageRoot:copy,workspaceRoot:fixture.workspaceRoot,workspaceId:fixture.workspaceId,projects:[fixture.scope.projectId]});}catch(e){error={code:e.code,message:e.message};}
   run.artifact('incompatible-owner.json',{owner,runtimeVersion:metadata.version,originalPackageDigest:sha(bytes),alteredPackageDigest:sha(fs.readFileSync(ref)),fault:'Only isolated package version metadata changed; original public package untouched',error,originalVerifiedAfter:api.verifyOwnerDistribution(owner,original)});
   assert.equal(error?.code,'OWNER_DISTRIBUTION_CHANGED');findings.push({owner,error});
  }
  return{explicitUnsupportedCombinationRejectedBeforeImport:true,versionLabelsCannotOverrideExactPins:true,originalOwnerPackagesUnchanged:true,findings};
 }
 async function independent(){
  const plan=read(path.join(run.selection.installedRoot,'installation-plan.json'));
  assert.equal(plan.codex,null);assert.equal(plan.integrationsRef,null,'Use a no-Agent/no-owner standalone service for the primary package journey');
  for(const p of ['node_modules/typescript','node_modules/@playwright','scripts','tests'])assert(!fs.existsSync(path.join(root,p)),'Development dependency/source runner in installed package: '+p);
  const before=await run.read('lifecycle.definition.inspect');
  const status=(await run.configurationEntry('cli','runtime.status')).result;assert.equal(status.version,'0.9.0');assert.equal(status.independentLlm,false);
  const base=(await run.configurationEntry('cli','lifecycle.base.inspect')).result;assert(base.fields.length>0);assert.equal(base.projectMutationAllowed,false);
  const validation=(await run.configurationEntry('cli','lifecycle.definition.validate',{yaml:'{}\n'})).result;
  assert.equal(validation.ready,false);assert.deepEqual(await run.read('lifecycle.definition.inspect'),before);
  const httpBase=await run.read('lifecycle.base.inspect');assert.deepEqual(base,httpBase);
  for(const page of ['/monitor','/lifecycle']){
   const response=await fetch(run.serviceOrigin+page,{redirect:'error',signal:AbortSignal.timeout(10000)}),body=await response.text();
   run.artifact('installed-page.json',{page,status:response.status,contentType:response.headers.get('content-type'),body});assert.equal(response.status,200);assert.match(body,/<html/);
  }
  const sourceRef=configuration.sourceRevision;assert.deepEqual(Object.keys(sourceRef).sort(),['ref','sha256']);
  const sourceBytes=fs.readFileSync(sourceRef.ref);assert.equal(sha(sourceBytes),sourceRef.sha256);const sourceCommit=sourceBytes.toString().trim();assert(/^[a-f0-9]{40}$/.test(sourceCommit));
  const git=await execute('/usr/bin/git',['-c','core.fsmonitor=false','rev-parse','HEAD'],repository);assert.equal(git.exitCode,0);assert.equal(git.stdout.trim(),sourceCommit);
  const clean=await execute('/usr/bin/git',['-c','core.fsmonitor=false','status','--porcelain'],repository);assert.equal(clean.exitCode,0);assert.equal(clean.stdout,'');
  const strict=read(path.join(repository,'tsconfig.json'));assert.equal(strict.compilerOptions.strict,true);assert.equal(strict.compilerOptions.noEmitOnError,true);
  const compiler=await execute(plan.nodeExecutable,[path.join(repository,'node_modules/typescript/bin/tsc'),'--noEmit'],repository);
  run.artifact('static-typescript-prerequisite.json',{sourceCommit,kind:'STATIC_PREREQUISITE_NOT_E2E',tsconfigDigest:sha(fs.readFileSync(path.join(repository,'tsconfig.json'))),compiler});assert.equal(compiler.exitCode,0);
  const check=await execute(plan.nodeExecutable,['scripts/check.mjs'],repository);
  run.artifact('static-source-classification.json',{sourceCommit,kind:'STATIC_PREREQUISITE_NOT_E2E',check});assert.equal(check.exitCode,0);
  const parent=configuration.parentNavigationRoot;assert.equal(fs.realpathSync(parent),parent);assert(!root.startsWith(parent+path.sep));
  const navigation=fs.readFileSync(path.join(parent,'README.md'),'utf8');
  for(const owner of ['runtime','ontology','harness'])assert(navigation.includes('evopilot-'+owner),'Parent navigation does not link '+owner);
  run.artifact('static-navigation-and-ci.json',{kind:'STATIC_PREREQUISITE_NOT_E2E',parentNavigationDigest:sha(navigation),parentModified:false,parentReleaseCreated:false,sourceCommit,ci:fs.readFileSync(path.join(repository,'.github/workflows/ci.yml'),'utf8'),noParentPathInInstallation:!JSON.stringify(plan).includes(parent)});
  assert(!JSON.stringify(plan).includes(parent));
  return{compiledInstalledCliAndHttp:true,staticPages:true,staticPrerequisitesSeparate:true,developmentDependenciesAbsent:true,parentDaemonRequired:false,codexConfigured:false,independentLlm:false,incompleteDefinitionBlocked:true,executionDispatched:false,sourceCommit,versionMatrix};
 }
 try{
  run.artifact('package-compatibility-selection.json',{fixtureReference:configuration.fixture,fixture,versionMatrix,scope:'Actual installed Runtime plus published 0.8.3 owners; isolated synthetic assets, no real project/domain claim'});
  for(const c of run.cases)await run.collect(c,()=>c.caseInstanceId==='E08.journey'?independent():c.caseInstanceId==='E08.variant.01'?compatible():c.caseInstanceId==='E08.variant.02'?incompatible():Promise.reject(Error('Unimplemented E08 case '+c.caseInstanceId)));
 }finally{for(const adapter of adapters.reverse())adapter.close();run.finish();}
}
if(process.argv[1]&&collectorPathToFileURL(collectorResolve(process.argv[1])).href===import.meta.url)test('E08 independent installed Runtime and published owner compatibility',executeE08);
