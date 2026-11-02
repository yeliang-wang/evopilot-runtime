import {randomUUID} from 'node:crypto';
import {constants,closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {canonical,record,reject,ServiceError,string} from '../server/errors.js';
import {authorize,privateFile,type Principal} from '../server/security.js';
import {RuntimeStore} from '../server/store.js';
import {byteDigest,valueDigest} from '../lifecycle/base.js';
import {atPath} from '../lifecycle/compiler.js';
import type {LifecycleInstance} from '../lifecycle/instance.js';
import type {StageAdapter,StageObservation,StagePlan,StageRequest} from '../lifecycle/execution.js';
import {configuredPlatform,readIntegrationConfiguration,type PlatformRegistration} from './config.js';
import {validateResourceDefinition,verifyResourceFile} from './bindings.js';
import {readPreparationPacket} from '../lifecycle/preparation.js';
import {readAgentHandoff,readAgentClaim,readAgentReport} from '../lifecycle/agent.js';
import {readImplementationEvidence} from './implementation-stages.js';
import {readReleaseMaterial} from './release-stages.js';
import {readPublicationEvidence} from './publication-stage.js';
import type {DistributionRequest,DistributionObservation} from './distribution.js';
import {ciInputs,validateRunRequest,type PlatformRunRequest,type PlatformArtifactArchive} from './platforms.js';
import {MAX_ARCHIVE_BYTES,readArtifactArchive,verifyCiArtifact,type CandidateInput} from './artifacts.js';
import {readInstallationManifest,observeInstallation,type VerifiedInstallationManifest,type InstallationObservation} from './installation.js';
import {verifyDeliverySmoke,validateDeliveryInput,type DeliveryInput,type VerifiedDeliverySmoke} from './delivery-smoke.js';
import {createClosureHarness,type ClosureHarnessInput} from './closure-harness.js';
import type {PublicationHarnessPin} from './publication-harness.js';
import {createOwnerFeedbackDelivery,type FeedbackObservation} from './feedback.js';
import {readVerificationFeedback,readVerificationFeedbackForRequest} from './stage-feedback.js';
import {inspectClosureArchive,writeClosureArchive,type ClosureArchiveInput,type ClosureArchiveObservation} from './closure-archive.js';
import type {NativeStageConnections,OwnerResult} from './stages.js';
import type {Owner} from './published-owners.js';

const ID='runtime-closure-stage-v1',ADAPTER_DIGEST=valueDigest({id:ID,smoke:'runtime-delivery-smoke/v1',harness:'runtime-closure-observation/v1',feedback:'registered-verification/v1',archive:'runtime-closure-archive/v1',recovery:'inspect-original-only'}),same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
interface Parameters {
  binding:PlatformRegistration;channelBinding:PlatformRegistration;commit:string;workflowDigest:string;resourceDigest:string;
  candidateInput:CandidateInput;distribution:DistributionRequest;deliveryInput:DeliveryInput;archiveDirectory:string;
  publicationRequestId:string;publicationOutcomeDigest:string;publicationEvidenceDigest:string;
  verificationRequestId:string;feedbackEventId:string;feedbackEventDigest:string;expectedChecks:string[];harness:PublicationHarnessPin;
}
interface ClosureFacts {smoke:VerifiedDeliverySmoke|null;distribution:Omit<DistributionObservation,'observedAt'>|null;installation:Omit<InstallationObservation,'observedAt'>|null;harness:OwnerResult|null;feedback:Record<Owner,FeedbackObservation>|null;archive:ClosureArchiveObservation|null;ciPhase:'CI_PENDING'|'CI_RUNNING'|null;reasons:string[];}
const code=(e:unknown)=>e instanceof ServiceError?e.code:'CLOSURE_OBSERVATION_UNAVAILABLE';
function required(store:RuntimeStore,projectId:string,kind:string,id:string):Record<string,unknown>{const raw=store.object(projectId,kind,id);if(!raw)reject('CLOSURE_PREREQUISITE','Original '+kind+' is required',409);return record(raw);}
function request(store:RuntimeStore,instance:LifecycleInstance,stageId:string):StageRequest{
  const s=instance.stages[stageId];if(!s?.requestId||s.status!=='PASSED'||!s.outcomeDigest)reject('CLOSURE_PREREQUISITE','Closure requires completed original predecessor stages',409);
  const r=required(store,instance.pins.projectId,'stage-request',s.requestId) as unknown as StageRequest,{digest,...body}=r,progress=required(store,r.projectId,'stage-progress',r.id);
  if(digest!==valueDigest(body)||r.planDigest!==valueDigest(r.plan)||r.workspaceId!==store.workspaceId||r.projectId!==instance.pins.projectId||r.instanceId!==instance.id||r.stageId!==stageId||r.pinsDigest!==instance.pinsDigest||r.inputDigest!==s.inputDigest||progress.terminal!==true||progress.phase!=='COMPLETE'||valueDigest(record(progress.observation).outcome)!==s.outcomeDigest)reject('CLOSURE_PREREQUISITE','Original predecessor outcome changed',409);return r;
}
export function readClosureEvidence(store:RuntimeStore,r:StageRequest){
  if(r.stageId!=='closure')reject('STAGE_SCOPE','Closure evidence requires its original request',409);
  const pointer=store.object(r.projectId,'closure-evidence-pointer',r.id) as {ref:string}|null,evidence=pointer?store.object(r.projectId,'closure-evidence',pointer.ref):null;
  if(pointer&&(!evidence||valueDigest(evidence)!==pointer.ref||record(evidence).requestDigest!==r.digest))reject('CORRUPT_CLOSURE','Retained closure evidence changed',503);
  return{evidenceRef:pointer?.ref??null,evidence,ciRequest:store.object(r.projectId,'closure-ci-action',r.id),harness:{input:store.object(r.projectId,'closure-harness-input',r.id),action:store.object(r.projectId,'closure-harness-action',r.id),receipt:store.object(r.projectId,'closure-harness-receipt',r.id)},archiveAction:store.object(r.projectId,'closure-archive-action',r.id),followup:store.object(r.projectId,'closure-followup',r.id),historical:true,automaticRedispatch:false};
}
/** CI/host workers perform the configured smoke/installation work. Runtime
 * independently observes the publication and selected local files, evaluates
 * native delivery quality and retains exact owner dispositions before closing. */
export function createClosureStageAdapter(store:RuntimeStore,configPath:string,connections:NativeStageConnections):StageAdapter{
  const harness=createClosureHarness(store,configPath,connections);
  function config(actor:Principal,projectId:string){authorize(actor,projectId,'read');return readIntegrationConfiguration(configPath,store.workspaceId);}
  function resources(instance:LifecycleInstance,actor:Principal){
    const c=config(actor,instance.pins.projectId),roles=['config.scope.deliveryTargetRef','config.closure.deliveryTargetRef','config.closure.smokeWorkflowRef','config.closure.archiveRef','config.closure.followupPolicyRef'],selected=roles.map(role=>{const r=c.resources.find(r=>r.projectId===instance.pins.projectId&&r.role===role&&r.ref===atPath(instance.definition.semantic,role));if(!r||Date.parse(r.expiresAt)<=Date.now())reject('CLOSURE_CONFIGURATION','Every current closure resource is required',409);validateResourceDefinition(r);return r;});
    if(!same(selected[0].definition,selected[1].definition)||selected[2].definition.purpose!=='smoke'||!same([...(atPath(instance.definition.semantic,'config.closure.feedbackOwners') as string[])].sort(),['harness','ontology']))reject('CLOSURE_CONFIGURATION','Delivery must match the accepted Target and retain both owner duties',409);
    const binding=configuredPlatform(c,actor,instance.pins.projectId,string(selected[2].definition.platformRef));return{c,binding,delivery:selected[1].definition,archiveDirectory:string(selected[3].definition.directory,4096),resourceDigest:valueDigest(selected)};
  }
  function prior(instance:LifecycleInstance,actor:Principal){
    const publication=request(store,instance,'publication'),verification=request(store,instance,'verification'),view=readPublicationEvidence(store,publication),e=record(view.evidence),m=readReleaseMaterial(store,instance,false),p=record(publication.plan.parameters),distribution=record(e.distribution),release=record(distribution.release),target=record(record(p.publication).target),channelBinding=p.binding as PlatformRegistration;
    if(e.currentGrant!==true||record(e.harness).status!=='PASS'||record(e.artifact).status!=='PASSED'||distribution.status!=='PASSED'||distribution.candidateDigest!==instance.candidateDigest||p.releaseMaterialDigest!==m.digest||m.candidateDigest!==instance.candidateDigest||!view.ciRequest||view.ciRequest.candidateDigest!==instance.candidateDigest)reject('CLOSURE_PREREQUISITE','Original publication and quality evidence are incomplete',409);
    const event=readVerificationFeedbackForRequest(store,actor,verification);
    if(event.stage!=='SUCCEEDED'||event.projectCandidateDigest!==instance.candidateDigest)reject('CLOSURE_PREREQUISITE','Closure requires the exact successful registered verification event',409);
    const d:DistributionRequest={commit:string(p.commit,40),candidate:instance.candidate!,tag:string(record(p.publication).tag),prerelease:target.prerelease as boolean,packageName:target.packageName as string|null,descriptionDigest:string(release.descriptionDigest,71)};
    return{publication,verification,event,view,m,channelBinding,distribution:d};
  }
  function retain(actor:Principal,r:StageRequest,kind:string,id:string,value:unknown,replace=false){
    const old=store.object(r.projectId,kind,id);if(old&&same(old,value))return;if(old&&!replace)reject('CLOSURE_FACT_CHANGED','Original closure action or fact cannot be replaced',409);
    store.mutate(actor,{projectId:r.projectId,operation:'lifecycle.closure.fact',requestId:'closure-fact-'+randomUUID(),expectedRevision:store.revision(r.projectId),input:{stageRequestId:r.id,kind,id,digest:valueDigest(value)},permission:'read'},()=>({objects:[{kind,id,value}],value:{kind,id},event:{type:'closure-fact-retained',data:{stageRequestId:r.id,kind,id}}}));
  }
  function archivePath(digest:string){if(!/^sha256:[a-f0-9]{64}$/.test(digest))reject('CLOSURE_ARCHIVE_INPUT','Exact original CI archive identity required',409);return join(store.root,'stage-ci-artifacts',digest.slice(7)+'.zip');}
  function bytes(digest:string,expectedBytes?:number){const path=archivePath(digest);privateFile(path);const size=lstatSync(path).size;if(size>MAX_ARCHIVE_BYTES||expectedBytes!==undefined&&size!==expectedBytes)reject('CLOSURE_ARCHIVE_INPUT','Original CI archive size differs',409);const value=readFileSync(path);if(byteDigest(value)!==digest)reject('CLOSURE_ARCHIVE_INPUT','Original CI archive bytes changed',409);return value;}
  function cache(a:PlatformArtifactArchive){
    if(a.bytes.length>MAX_ARCHIVE_BYTES||a.archiveBytes!==a.bytes.length||byteDigest(a.bytes)!==a.archiveDigest)reject('CLOSURE_ARCHIVE_INPUT','Downloaded original archive identity changed',409);
    const root=join(store.root,'stage-ci-artifacts');mkdirSync(root,{recursive:true,mode:0o700});const s=lstatSync(root);if(!s.isDirectory()||realpathSync(root)!==root||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)reject('UNSAFE_STATE','Archive cache must be an owned private directory',409);
    const path=archivePath(a.archiveDigest);if(existsSync(path)){bytes(a.archiveDigest,a.archiveBytes);return;}const tmp=path+'.'+randomUUID()+'.pending',fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,a.bytes);fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);const dir=openSync(root,constants.O_RDONLY);try{fsyncSync(dir);}finally{closeSync(dir);}
  }
  async function installation(input:CandidateInput,delivery:Record<string,unknown>,signal:AbortSignal):Promise<VerifiedInstallationManifest|null>{
    if(delivery.mode==='distribution')return null;const raw=bytes(input.archive.archiveDigest,input.archive.archiveBytes),files=await readArtifactArchive(raw,signal),name=string(delivery.manifestArtifact),manifest=files.get('artifacts/'+name);if(!manifest)reject('INSTALLATION_CANDIDATE','Original candidate must contain the installation manifest',409);return readInstallationManifest(input.manifest,name,manifest);
  }
  const feedback=createOwnerFeedbackDelivery(store,{event:async(actor,projectId,id)=>readVerificationFeedback(store,actor,projectId,id),owner(event,kind){
    const c=readIntegrationConfiguration(configPath,store.workspaceId),source=required(store,event.projectId,'stage-feedback-source',event.id),r=required(store,event.projectId,'stage-request',string(source.requestId)),p=record(record(r.plan).parameters),pin=record(record(p.owners)[kind]);
    if(!same(pin.reference,event.pins[kind]))reject('FEEDBACK_CONNECTION_CHANGED','Feedback must retain the original owner reference',409);const a=connections.owner(string(pin.ref),c);if(a.owner!==kind||a.workspaceId!==store.workspaceId||record(a.capabilities()).registrationDigest!==pin.registrationDigest)reject('FEEDBACK_CONNECTION_CHANGED','Feedback cannot move to another owner registration',409);return a;
  }});
  function original(r:StageRequest,i:LifecycleInstance,actor:Principal){
    const{digest,...body}=r,p=r.plan.parameters as unknown as Parameters,c=resources(i,actor),previous=prior(i,actor),stage=i.stages.closure;
    if(digest!==valueDigest(body)||r.schema!=='runtime-stage-request/v1'||r.workspaceId!==store.workspaceId||r.projectId!==i.pins.projectId||r.instanceId!==i.id||r.pinsDigest!==i.pinsDigest||r.stageId!=='closure'||stage.requestId!==r.id||stage.inputDigest!==r.inputDigest||r.plan.adapterId!==ID||r.plan.adapterDigest!==ADAPTER_DIGEST||r.plan.action!=='base.closure'||r.planDigest!==valueDigest(r.plan)||r.plan.bindingDigest!==valueDigest(p)||p.resourceDigest!==c.resourceDigest||!same(p.binding,c.binding)||!same(p.channelBinding,previous.channelBinding)||!same(p.distribution,previous.distribution)||!same(p.candidateInput,previous.m.candidateInput)||p.publicationRequestId!==previous.publication.id||p.publicationOutcomeDigest!==i.stages.publication.outcomeDigest||p.publicationEvidenceDigest!==previous.view.evidenceRef||p.verificationRequestId!==previous.verification.id||p.feedbackEventId!==previous.event.id||p.feedbackEventDigest!==previous.event.digest||p.archiveDirectory!==c.archiveDirectory||!same(p.expectedChecks,i.definition.nodes.find(n=>n.id==='closure')!.checks))reject('CLOSURE_PLAN_CHANGED','Closure differs from its original scope, predecessors or resources',409);
    harness.current(p.harness,r.projectId);const ci=validateRunRequest({schema:'runtime-ci-request/v1',requestId:'closure-'+valueDigest({workspaceId:r.workspaceId,projectId:r.projectId,requestId:r.id}).slice(7,55),projectId:r.projectId,bindingDigest:valueDigest(p.binding),commit:p.commit,workflowDigest:p.workflowDigest,inputDigest:r.inputDigest,stageId:'closure',candidateDigest:i.candidateDigest,candidateInput:p.candidateInput,deliveryInput:p.deliveryInput,requestedAt:r.requestedAt,deadlineAt:r.deadlineAt},p.binding);
    if(Buffer.byteLength(canonical(ciInputs(ci)))>65536)reject('DELIVERY_INPUT','Combined CI inputs exceed the fixed dispatch bound',409);return{p,c,previous,ci};
  }
  function observed(r:StageRequest,p:Parameters,phase:StageObservation['phase'],ref:string,delivery=false,owners=false):StageObservation{return{requestId:r.id,inputDigest:r.inputDigest,adapterDigest:ADAPTER_DIGEST,phase,handle:{deliveryMode:p.deliveryInput.target.mode,feedbackEventId:p.feedbackEventId},outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'runtime:closure-stage/'+r.id,status:phase==='COMPLETE'?'COMPLETE':phase==='FAILED'?'FAILED':phase==='UNKNOWN'?'UNKNOWN':'RUNNING',expiresAt:r.deadlineAt,checks:['COMPLETE','FAILED'].includes(phase)?p.expectedChecks.map(id=>({id,status:phase==='COMPLETE'?'PASS':id==='base.closure.delivery-acceptance'?(delivery?'PASS':'FAIL'):(owners?'PASS':'FAIL'),evidenceRef:ref})):[]}};}
  function harnessInput(p:Parameters,f:ClosureFacts):ClosureHarnessInput{return{smoke:f.smoke!,distribution:f.distribution!,installation:f.installation,publicationEvidenceDigest:p.publicationEvidenceDigest,feedbackEventDigest:p.feedbackEventDigest};}
  function archiveInput(r:StageRequest,i:LifecycleInstance,p:Parameters,f:ClosureFacts,actor:Principal):ClosureArchiveInput{
    const documents:NonNullable<ClosureArchiveInput['documents']>=[],artifacts:ClosureArchiveInput['artifacts']=[],seen=new Set<string>(),index:{kind:string;id:string;file:string;digest:string}[]=[];
    const add=(kind:string,id:string,value:unknown)=>{
      if(value===null||value===undefined)reject('CLOSURE_ARCHIVE_INPUT','Original '+kind+' is required for archival',409);
      const content=record(value),file='record-'+valueDigest({kind,id}).slice(7)+'.json';
      if(index.some(x=>x.file===file))return;
      index.push({kind,id,file,digest:valueDigest(content)});documents.push({name:file,content});
    };
    const addStored=(kind:string,id:string,mandatory=false)=>{const value=store.object(r.projectId,kind,id);if(value||mandatory)add(kind,id,value);return value;};
    const addZip=(v:unknown)=>{const a=record(v),digest=string(a.archiveDigest,71);if(seen.has(digest))return;seen.add(digest);const path=archivePath(digest);privateFile(path);artifacts.push({name:digest.slice(7)+'.zip',sourcePath:path,digest,bytes:lstatSync(path).size});};
    // Explicit immutable fields make the specification identical whether called
    // with a fresh observation or the retained evidence envelope after restart.
    const delivery={smoke:f.smoke,distribution:f.distribution,installation:f.installation,harness:f.harness,feedback:f.feedback};
    add('definition',i.pins.definitionRevisionId,{pins:i.pins,pinsDigest:i.pinsDigest,definition:i.definition,candidate:i.candidate,candidateDigest:i.candidateDigest});
    addStored('definition-revision',i.pins.definitionRevisionId,true);add('closure-request',r.id,r);add('delivery',r.id,delivery);
    for(const kind of ['closure-harness-input','closure-harness-action','closure-harness-receipt','closure-ci-action','closure-ci-source'])addStored(kind,r.id,true);
    const packet=readPreparationPacket(store,r.projectId,i.pins.targetRef);add('preparation',i.pins.targetRef,packet);
    for(const[role,pin]of Object.entries(packet.input.documents)){
      if(!pin)continue;const id=valueDigest(pin);let doc=store.object(r.projectId,'closure-preparation-document',id);
      if(!doc){verifyResourceFile(pin);const raw=readFileSync(pin.path);if(raw.length>8388608||byteDigest(raw)!==pin.digest)reject('CLOSURE_ARCHIVE_INPUT','Exact original preparation document is unavailable',409);let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{return reject('CLOSURE_ARCHIVE_INPUT','Preparation document must retain valid UTF-8 bytes',409);}verifyResourceFile(pin);doc={...pin,bytes:raw.length,text};retain(actor,r,'closure-preparation-document',id,doc);}
      const d=record(doc);if(d.path!==pin.path||d.digest!==pin.digest||Buffer.byteLength(string(d.text,8388608))!==d.bytes||byteDigest(string(d.text,8388608))!==pin.digest)reject('CLOSURE_ARCHIVE_INPUT','Retained preparation bytes changed',409);add('preparation-document',role,doc);
    }
    for(const owner of ['ontology','harness']){const id=p.feedbackEventId+':'+owner;addStored('owner-feedback-inbox',id,true);for(const kind of ['owner-feedback-delivery','owner-feedback-permit'])addStored(kind,id);}
    const evidenceKinds=['plan-stage-evidence','implementation-stage-evidence','ci-stage-evidence','publication-evidence'];
    for(const[stageId,stage]of Object.entries(i.stages)){
      if(stageId==='closure')continue;
      if(stage.status!=='PASSED'||!stage.requestId)reject('CLOSURE_ARCHIVE_INPUT','Every required stage must retain its completed original request',409);
      const sr=request(store,i,stageId),id=sr.id,progress=required(store,r.projectId,'stage-progress',id);
      add('stage-request',id,sr);add('stage-progress',id,progress);
      if(typeof progress.observationRef==='string')addStored('stage-observation',progress.observationRef);
      for(const kind of ['scope-stage-evidence','plan-stage-input','implementation-ci-derivation','stage-evaluation-run','release-stage-material','publication-harness-input','publication-harness-action','publication-harness-receipt','stage-candidate-source','ci-stage-artifact','publication-ci-artifact'])addStored(kind,id);
      for(const kind of ['stage-native-action','stage-native-receipt','plan-stage-native-action','plan-stage-native-receipt'])for(const owner of ['ontology','harness'])addStored(kind,id+':'+owner);
      for(const check of record(record(progress.observation).outcome).checks as Record<string,unknown>[])for(const kind of evidenceKinds)addStored(kind,string(check.evidenceRef));
      const artifact=store.object(r.projectId,'ci-stage-artifact',id);if(artifact)addZip(artifact);
      for(const ref of [sr.authorityRef,sr.releaseAuthorityRef])if(ref?.startsWith('authority:'))addStored('authority-decision',ref,true);
      if(stageId==='implementation'){
        add('agent-handoff',id,readAgentHandoff(store,r.projectId,id).handoff);add('agent-claim',id,readAgentClaim(store,r.projectId,id));
        let report=readAgentReport(store,r.projectId,id),count=0;while(report){if(++count>64)reject('CLOSURE_ARCHIVE_INPUT','Agent report chain exceeds the bounded archive',409);add('agent-report',report.digest,report);if(!report.previousReportDigest)break;const previous=required(store,r.projectId,'agent-report',report.previousReportDigest),{digest,...body}=previous;if(digest!==report.previousReportDigest||valueDigest(body)!==digest||previous.stageRequestId!==id)reject('CLOSURE_ARCHIVE_INPUT','Original Agent report chain changed',409);report=previous as unknown as typeof report;}
        const review=required(store,r.projectId,'implementation-review-pointer',id);addStored('implementation-review',string(review.ref),true);
        const evidence=readImplementationEvidence(store,sr);add('implementation-evidence',id,evidence);if(!evidence.derivation||!evidence.ci?.artifact)reject('CLOSURE_ARCHIVE_INPUT','Original implementation CI is missing',409);addZip(evidence.ci.artifact);
      }
    }
    add('release-material',p.publicationRequestId,readReleaseMaterial(store,i,false));addStored('publication-evidence',p.publicationEvidenceDigest,true);addZip(p.candidateInput.archive);addZip(required(store,r.projectId,'publication-ci-artifact',p.publicationRequestId));addZip(f.smoke!.ci);add('feedback-event',p.feedbackEventId,readVerificationFeedback(store,actor,r.projectId,p.feedbackEventId));
    return{workspaceId:r.workspaceId,projectId:r.projectId,instanceId:r.instanceId,requestDigest:r.digest,content:{schema:'runtime-closure-evidence-index/v1',requestDigest:r.digest,candidateDigest:i.candidateDigest,publicationEvidenceDigest:p.publicationEvidenceDigest,feedbackEventId:p.feedbackEventId,deliveryDigest:valueDigest(delivery),state:'DELIVERY_VERIFIED_CORE_COMMIT_PENDING',followupRequired:false,records:index.sort((a,b)=>a.file.localeCompare(b.file))},documents:documents.sort((a,b)=>a.name.localeCompare(b.name)),artifacts:artifacts.sort((a,b)=>a.name.localeCompare(b.name))};
  }
  async function inspect(r:StageRequest,i:LifecycleInstance,_progress:unknown,actor:Principal,signal:AbortSignal):Promise<StageObservation>{
    const{p,c,previous,ci}=original(r,i,actor),facts:ClosureFacts={smoke:null,distribution:null,installation:null,harness:null,feedback:null,archive:null,ciPhase:null,reasons:[]};
    try{const distribution=await connections.platform(p.channelBinding).distribution(actor,p.distribution,signal);const{observedAt,...rest}=distribution;facts.distribution=rest;}catch(e){facts.reasons.push(code(e));}
    let actualInstallation:InstallationObservation|null=null;
    try{const manifest=await installation(p.candidateInput,c.delivery,signal);if(manifest){if(p.deliveryInput.target.mode==='distribution'||manifest.digest!==p.deliveryInput.target.manifestDigest)reject('INSTALLATION_CANDIDATE','Original installation manifest changed',409);actualInstallation=observeInstallation(string(c.delivery.directory,4096),manifest,signal);const{observedAt,...rest}=actualInstallation;facts.installation=rest;}}catch(e){facts.reasons.push(code(e));}
    const marker=store.object(r.projectId,'closure-ci-action',r.id);
    if(marker){if(!same(marker,{requestDigest:r.digest,planDigest:r.planDigest,ci}))reject('CLOSURE_PLAN_CHANGED','Original smoke request changed',409);
      try{
        let source=store.object(r.projectId,'closure-ci-source',r.id) as Omit<PlatformArtifactArchive,'bytes'>|null;
        if(!source){const client=connections.platform(p.binding),known=store.object(r.projectId,'closure-ci-run',r.id) as {runId:string}|null,run=await client.run(actor,ci,known?.runId??null,signal);if(run.runId)retain(actor,r,'closure-ci-run',r.id,{runId:run.runId});if(run.status==='PENDING'||run.status==='RUNNING')facts.ciPhase=run.status==='PENDING'?'CI_PENDING':'CI_RUNNING';
          if(run.runId&&['PASSED','FAILED'].includes(run.status)){const a=await client.artifact(actor,ci,run.runId,signal);cache(a);const{bytes:unused,...meta}=a;source=meta;retain(actor,r,'closure-ci-source',r.id,source);}else if(run.status==='FAILED')facts.reasons.push('SMOKE_CI_FAILED');else if(run.status==='UNKNOWN')facts.reasons.push('SMOKE_CI_UNKNOWN');}
        if(source)facts.smoke=await verifyDeliverySmoke({...source,bytes:bytes(source.archiveDigest,source.archiveBytes)},ci,p.deliveryInput.target,actualInstallation,signal);
      }catch(e){facts.reasons.push(code(e));}
    }else facts.reasons.push('SMOKE_NOT_DISPATCHED');
    if(facts.smoke?.status==='PASSED'&&facts.distribution?.status==='PASSED')try{facts.harness=await harness.inspect(r,i,p.harness,harnessInput(p,facts),actor,signal);}catch(e){facts.reasons.push(code(e));}
    if(store.object(r.projectId,'owner-feedback-event',p.feedbackEventId))try{facts.feedback={ontology:await feedback.inspect(actor,r.projectId,p.feedbackEventId,'ontology',signal),harness:await feedback.inspect(actor,r.projectId,p.feedbackEventId,'harness',signal)};}catch(e){facts.reasons.push(code(e));}
    const delivery=facts.smoke?.status==='PASSED'&&facts.distribution?.status==='PASSED'&&facts.harness?.status==='PASS',owners=facts.feedback?.ontology.status==='REUSE_APPROVED'&&facts.feedback.harness.status==='REUSE_APPROVED';
    if(delivery&&owners&&!facts.reasons.length)try{
      // Preserve the original publication CI archive alongside every earlier
      // stage archive, rather than archiving only references to expiring URLs.
      const old=required(store,r.projectId,'publication-ci-artifact',p.publicationRequestId);if(!existsSync(archivePath(string(old.archiveDigest,71)))){const raw=await connections.platform(p.channelBinding).artifact(actor,previous.view.ciRequest!,string(old.runId),signal),verified=await verifyCiArtifact(raw,previous.view.ciRequest!,previous.publication.plan.parameters.expectedChecks as string[],signal);if(!same(verified,old))reject('CLOSURE_ARCHIVE_INPUT','Original publication archive differs',409);cache(raw);}
      facts.archive=inspectClosureArchive(p.archiveDirectory,archiveInput(r,i,p,facts,actor),signal);
      if(facts.archive.status==='ABSENT'&&store.object(r.projectId,'closure-archive-action',r.id))facts.reasons.push('ARCHIVE_ACTION_OUTCOME_UNKNOWN');
    }catch(e){facts.reasons.push(code(e));}
    if(facts.smoke?.status==='UNKNOWN')facts.reasons.push('SMOKE_RESULT_UNKNOWN');
    if(facts.harness?.status==='UNKNOWN'&&store.object(r.projectId,'closure-harness-action',r.id))facts.reasons.push('HARNESS_ACTION_OUTCOME_UNKNOWN');
    if(facts.feedback&&Object.values(facts.feedback).some(x=>x.status==='UNKNOWN'))facts.reasons.push('FEEDBACK_ACTION_OUTCOME_UNKNOWN');
    if(facts.distribution&&facts.distribution.status!=='PASSED')facts.reasons.push('DISTRIBUTION_'+facts.distribution.status);
    const body={schema:'runtime-closure-evidence/v1',requestDigest:r.digest,planDigest:r.planDigest,candidateDigest:i.candidateDigest,...facts},ref=valueDigest(body);retain(actor,r,'closure-evidence',ref,body);retain(actor,r,'closure-evidence-pointer',r.id,{ref},true);
    const failed=facts.smoke?.status==='FAILED'||facts.harness?.status==='FAIL'||facts.feedback&&Object.values(facts.feedback).some(f=>['REJECTED','REBIND_REQUIRED'].includes(f.status))||facts.archive?.status==='MISMATCH'||facts.reasons.includes('SMOKE_CI_FAILED');
    const phase:StageObservation['phase']=failed?'FAILED':facts.reasons.length?'UNKNOWN':delivery&&owners&&facts.archive?.status==='COMPLETE'?'COMPLETE':facts.archive?.status==='PARTIAL'?'UNKNOWN':facts.ciPhase??'RUNNING';
    if(failed||facts.archive?.status==='PARTIAL')retain(actor,r,'closure-followup',r.id,{schema:'runtime-followup-target-candidate/v1',causeId:r.id,evidenceRef:ref,priorTargetRef:i.pins.targetRef,candidateDigest:i.candidateDigest,reasonCodes:facts.reasons,ownerStates:facts.feedback,archiveStatus:facts.archive?.status??null,requiresReview:true,executionAuthorized:false},true);
    return observed(r,p,phase,ref,!!delivery,!!owners);
  }
  async function dispatch(r:StageRequest,i:LifecycleInstance,permit:()=>Promise<Principal>,signal:AbortSignal):Promise<StageObservation>{
    const actor=await permit(),{p,ci}=original(r,i,actor);signal.throwIfAborted();await feedback.retain(actor,r.projectId,p.feedbackEventId,signal);
    if(!store.object(r.projectId,'closure-ci-action',r.id)){
      retain(actor,r,'closure-ci-action',r.id,{requestDigest:r.digest,planDigest:r.planDigest,ci});const client=connections.platform(p.binding);
      const run=await client.dispatch(ci,async requested=>{if(!same(requested,ci))reject('CLOSURE_PLAN_CHANGED','Provider changed the original smoke request',409);const fresh=await permit();original(r,i,fresh);signal.throwIfAborted();return fresh;},signal);if(run.runId)retain(actor,r,'closure-ci-run',r.id,{runId:run.runId});
    }
    return inspect(r,i,null,actor,signal);
  }
  return{async prepare(i,stageId,actor,signal):Promise<StagePlan>{
    if(stageId!=='closure')reject('STAGE_ADAPTER_UNAVAILABLE','This adapter owns closure only',409);authorize(actor,i.pins.projectId,'execution.request');const c=resources(i,actor),previous=prior(i,actor);
    for(const key of ['provider','host','repositoryId','repository'] as const)if(c.binding[key]!==previous.channelBinding[key])reject('CLOSURE_CONFIGURATION','Smoke must use the published exact source repository',409);
    if(c.delivery.mode==='distribution'&&c.delivery.platformRef!==previous.channelBinding.ref)reject('CLOSURE_CONFIGURATION','Distribution target must match the actual publication channel',409);
    const source=await connections.platform(c.binding).revision(actor,previous.distribution.commit,signal);if(source.projectId!==i.pins.projectId||source.repositoryId!==c.binding.repositoryId||source.commit!==previous.distribution.commit||source.bindingDigest!==valueDigest(c.binding)||source.sourceSelection!=='exact-commit'||Date.parse(source.expiresAt)<=Date.now())reject('CLOSURE_CONFIGURATION','Exact smoke workflow revision is required',409);
    const manifest=await installation(previous.m.candidateInput,c.delivery,signal),deliveryInput:DeliveryInput=manifest?{schema:'runtime-delivery-input/v1',target:{mode:c.delivery.mode as 'local-install'|'approved-deployment',directory:string(c.delivery.directory,4096),manifestDigest:manifest.digest},manifestArtifact:string(c.delivery.manifestArtifact)}:{schema:'runtime-delivery-input/v1',target:{mode:'distribution',bindingDigest:valueDigest(previous.channelBinding),commit:source.commit,tag:previous.distribution.tag,descriptionDigest:previous.distribution.descriptionDigest},manifestArtifact:null};validateDeliveryInput(deliveryInput,{stageId:'closure',candidateInput:previous.m.candidateInput});
    const p:Parameters={binding:c.binding,channelBinding:previous.channelBinding,commit:source.commit,workflowDigest:source.workflowDigest,resourceDigest:c.resourceDigest,candidateInput:previous.m.candidateInput,distribution:previous.distribution,deliveryInput,archiveDirectory:c.archiveDirectory,publicationRequestId:previous.publication.id,publicationOutcomeDigest:i.stages.publication.outcomeDigest!,publicationEvidenceDigest:previous.view.evidenceRef!,verificationRequestId:previous.verification.id,feedbackEventId:previous.event.id,feedbackEventDigest:previous.event.digest,expectedChecks:i.definition.nodes.find(n=>n.id==='closure')!.checks,harness:await harness.prepare(i,actor,signal)};
    return{adapterId:ID,adapterDigest:ADAPTER_DIGEST,action:'base.closure',bindingDigest:valueDigest(p),parameters:p as unknown as Record<string,unknown>};
  },dispatch,inspect,async advance(r,i,_progress,permit,signal){
    let current=await dispatch(r,i,permit,signal);if(current.phase!=='RUNNING')return current;
    const allowed=async()=>{const actor=await permit();original(r,i,actor);signal.throwIfAborted();return actor;};let actor=await allowed(),{p}=original(r,i,actor),facts=record(readClosureEvidence(store,r).evidence) as unknown as ClosureFacts;
    if(facts.smoke?.status==='PASSED'&&facts.distribution?.status==='PASSED'&&facts.harness?.status==='UNKNOWN'){await harness.advance(r,i,p.harness,harnessInput(p,facts),allowed,signal);current=await inspect(r,i,null,actor,signal);if(current.phase!=='RUNNING')return current;facts=record(readClosureEvidence(store,r).evidence) as unknown as ClosureFacts;}
    if(facts.harness?.status==='PASS'){
      for(const owner of ['ontology','harness'] as const)await feedback.deliver(actor,r.projectId,p.feedbackEventId,owner,async()=>({actor:await allowed(),authorityRef:r.authorityRef,expiresAt:r.deadlineAt}),signal);
      current=await inspect(r,i,null,actor,signal);if(current.phase!=='RUNNING')return current;facts=record(readClosureEvidence(store,r).evidence) as unknown as ClosureFacts;
      if(facts.feedback?.ontology.status==='REUSE_APPROVED'&&facts.feedback.harness.status==='REUSE_APPROVED'&&facts.archive?.status==='ABSENT'){
        const input=archiveInput(r,i,p,facts,actor),marker=store.object(r.projectId,'closure-archive-action',r.id);if(!marker){actor=await allowed();retain(actor,r,'closure-archive-action',r.id,{requestDigest:r.digest,specificationDigest:facts.archive.specificationDigest,directory:facts.archive.directory});writeClosureArchive(p.archiveDirectory,input,signal);}
        return inspect(r,i,null,actor,signal);
      }
    }
    return current;
  }};
}
