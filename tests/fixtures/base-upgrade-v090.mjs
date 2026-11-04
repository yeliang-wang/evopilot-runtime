// Synthetic SOURCE regression fixture only. This deliberately constructs an
// original snapshot for deterministic compiler tests. It is not a publisher
// release, native installed migration, provider E2E or a release authority.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, canonicalEvidence } from '../../dist/server/errors.js';
import { byteDigest, loadPublisherBase, valueDigest } from '../../dist/lifecycle/base.js';
import { compileLifecycle } from '../../dist/lifecycle/compiler.js';
import { requiredChecksDigest } from '../../dist/lifecycle/instance.js';
import { loadServiceUpgradeContext } from '../../dist/lifecycle/base-upgrade.js';
import { RuntimeStore } from '../../dist/server/store.js';
import { lifecycle, yaml, extension, syntheticBindings } from './lifecycle-v090.mjs';

export function qualificationBase(){
  const base=structuredClone(loadPublisherBase().base);
  base.version='0.9.0-ex10-a';base.schema='runtime-base-lifecycle/ex10-a';
  base.fields=base.fields.filter(f=>f.path!=='config.scope.deliveryTargetRef');
  base.fields.find(f=>f.path==='schema').rules.fixed='runtime-project-lifecycle/ex10-a';
  base.fields.find(f=>f.path==='config.plan.budget.timeoutSeconds').rules.maximum=7200;
  base.slots['legacy-after-plan']={predecessor:'plan',successor:'implementation',types:['review','check']};
  const bytes=Buffer.from(JSON.stringify(base,null,2)+'\n'),pin={id:base.id,version:base.version,schemaVersion:base.schema,digest:byteDigest(bytes)};
  const manifest=Buffer.from(JSON.stringify({schema:'runtime-base-distribution/v1',publisher:'evopilot-runtime',bases:[{...pin,file:'software-release-0.9.0-ex10-a.json'}]},null,2)+'\n');
  return{base,bytes,pin,manifest};
}
export function historicalSource(){
  const old=qualificationBase(),current=lifecycle();current.extensions=[extension('legacy')];
  const compiled=compileLifecycle(yaml(current),'alpha');if(!compiled.valid)throw Error('Synthetic current source is invalid');
  const data=structuredClone(current);delete data.config.scope.deliveryTargetRef;data.schema='runtime-project-lifecycle/ex10-a';data.extends=old.pin;data.extensions[0].slot='legacy-after-plan';
  const compilation=structuredClone(compiled),effective=compilation.effective;
  delete effective.semantic.config.scope.deliveryTargetRef;effective.semantic.schema=data.schema;effective.semantic.extends=old.pin;effective.semantic.extensions[0].slot='legacy-after-plan';
  effective.base=old.pin;effective.semanticDigest=valueDigest(effective.semantic);delete effective.fieldSources['config.scope.deliveryTargetRef'];
  const node=effective.nodes.find(n=>n.id==='project.legacy');node.stage='legacy-after-plan';node.action.slot='legacy-after-plan';
  const source='# Synthetic sealed A source; never rewritten by migration\n'+yaml(data);compilation.sourceDigest=byteDigest(source);
  const id=valueDigest({yaml:source,compilation}),revision={schema:'runtime-definition-revision/v1',id,yaml:source,compilation,createdBy:'synthetic-owner',createdAt:'2026-01-01T00:00:00.000Z'};
  const authority={projectId:'alpha',instanceId:'old-instance',definitionRevisionId:id,semanticDigest:effective.semanticDigest,goalRef:'synthetic:goal',targetRef:'synthetic:target',loopRef:'synthetic:loop',requirementsDigest:requiredChecksDigest(effective),budget:{timeoutSeconds:60,maxAttempts:1,maxConcurrency:1,maxLoops:1},evidenceRef:'synthetic:authority',revision:'synthetic-1',expiresAt:'2030-01-01T00:00:00.000Z'};
  const pins={projectId:'alpha',definitionRevisionId:id,semanticDigest:effective.semanticDigest,base:old.pin,requirementsDigest:authority.requirementsDigest,graphDigest:valueDigest(effective.nodes),authorityDigest:valueDigest(authority),goalRef:authority.goalRef,targetRef:authority.targetRef,loopRef:authority.loopRef,budget:authority.budget,authorityExpiresAt:authority.expiresAt};
  const instance={schema:'runtime-lifecycle-instance/v1',id:'old-instance',pins,pinsDigest:valueDigest(pins),definition:effective,stages:Object.fromEntries(effective.nodes.map(n=>[n.id,{status:'PENDING',attempts:0,requestId:null,inputDigest:null,requestedAt:null,receiptRef:null,outcomeDigest:null,expiresAt:null}])),requestIds:[],candidate:null,candidateDigest:null,createdAt:'2026-01-01T00:00:00.000Z'};
  return{old,current,data,source,revision,instance,authority};
}
export function baseUpgradeFixture(){
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-ex10-source-')),stateRoot=join(dir,'state'),backupRoot=join(dir,'backup');mkdirSync(backupRoot,{mode:0o700});
  const store=new RuntimeStore(stateRoot,'synthetic-upgrade'),original=historicalSource();
  const actor={id:'synthetic-owner',projects:['alpha'],permissions:['read','draft.write','definition.activate','execution.request'],revision:1,expiresAt:'2030-01-01T00:00:00.000Z'};
  const objects=[{kind:'definition-revision',id:original.revision.id,value:original.revision},{kind:'lifecycle-instance',id:original.instance.id,value:original.instance},{kind:'definition-pointer',id:'draft',value:{revisionId:original.revision.id}},{kind:'definition-pointer',id:'active',value:{revisionId:original.revision.id}}];
  const receipt=store.mutate(actor,{projectId:'alpha',operation:'synthetic.source-history.fixture',requestId:'synthetic-import',expectedRevision:0,input:{synthetic:true},permission:'draft.write'},()=>({objects,value:{synthetic:true},event:{type:'synthetic-source-history-fixture',data:{installedMigration:false}}}),()=>actor);
  const historicalRecords=objects.filter(o=>['definition-revision','lifecycle-instance'].includes(o.kind)).map(o=>({projectId:'alpha',kind:o.kind,id:o.id,valueDigest:valueDigest(o.value)}));
  const shared={workspaceId:'synthetic-upgrade',serviceId:store.serviceId,sourceInstalledRoot:join(dir,'synthetic-source-installation'),sourceManifestDigest:valueDigest('synthetic-package-manifest'),sourceArchiveDigest:valueDigest('synthetic-package-archive'),sourceBasePin:original.old.pin,historicalRecords};
  const snapshot=Buffer.from(canonicalEvidence({...shared,synthetic:true,installedMigration:false})+'\n'),sourceSnapshotDigest=byteDigest(snapshot);
  const context={schema:'runtime-service-upgrade-context/v1',...shared,baseBytesSha256:byteDigest(original.old.bytes),sourceSnapshotDigest,backupRoot,backupDigest:valueDigest({baseBytesSha256:byteDigest(original.old.bytes),baseManifestDigest:byteDigest(original.old.manifest),sourceSnapshotDigest})};
  for(const [file,bytes]of [['base.json',original.old.bytes],['base-manifest.json',original.old.manifest],['snapshot.json',snapshot]])writeFileSync(join(backupRoot,file),bytes,{mode:0o600,flag:'wx'});
  const contextPath=join(stateRoot,'service-upgrade.json');writeFileSync(contextPath,canonicalEvidence(context),{mode:0o600,flag:'wx'});
  const history=loadServiceUpgradeContext(stateRoot,'synthetic-upgrade',store.serviceId),bindings=syntheticBindings();
  return{dir,stateRoot,backupRoot,contextPath,store,actor,original,context,history,bindings,receipt,reload:()=>loadServiceUpgradeContext(stateRoot,'synthetic-upgrade',store.serviceId),originalBytes:()=>readFileSync(join(backupRoot,'base.json')),cleanup(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
