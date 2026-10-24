import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRuntimeService} from '@evopilot-next/runtime/service';
import {usabilityDigest as hash} from '../../vendor/usability/v1/contract.mjs';
import {nativeBytesDigest} from '../../vendor/compatibility/v1/native.mjs';
import {syntheticDecisionEvidence} from './native/decision-evidence.mjs';
export {hash};
export function receipt(claim,overrides={}){
 const outputs=[{path:'app.mjs',bytes:10,digest:hash('synthetic-output')}];
 const body={schema:'evopilot-reconstruction-receipt/v1',claimId:claim.claimId,planDigest:claim.planDigest,attemptId:claim.attemptId,status:'SUCCEEDED',origin:claim.plan.origin,executorDigest:hash(claim.plan.executor),inputManifestDigest:claim.plan.inputManifestDigest,environmentDigest:claim.plan.environmentDigest,dependenciesDigest:claim.plan.dependenciesDigest,workspaceId:'workspace-'+claim.attemptId,cleanStart:true,isolation:'DENY_BY_DEFAULT',networkDenied:true,stages:{generation:'SUCCEEDED',build:'SUCCEEDED',run:'SUCCEEDED'},usage:{wallMs:10,tokens:10,costMicros:1,iterations:1},interventions:[],outputs,outputDigest:hash(outputs),traceDigest:hash('synthetic-trace'),diagnostic:null,...overrides};
 return {...body,digest:hash(body)};
}
export function observation(claim,r){
 const p=claim.plan,body={schema:'evopilot-reconstruction-observation/v1',workspaceId:claim.workspaceId,scope:claim.scope,attemptId:claim.attemptId,...Object.fromEntries(['inventoryDigest','specificationDigest','oracleDigest','inputManifestDigest','environmentDigest','dependenciesDigest'].map(k=>[k,p[k]])),outputDigest:r.outputDigest,executorDigest:r.executorDigest,origin:p.origin,inputMode:p.inputMode,independent:p.independentConsumer,isolated:true,status:'SUCCEEDED',cases:[]};return {...body,digest:hash(body)};
}
export async function reconstructionFixture(t,{providerOverrides={},budget={},prepare=true}={}){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'evopilot-reconstruction-')),options={workspaceRoot:path.join(root,'state'),workspaceId:'reconstruction-test'},scope={visibility:'private',projectId:'example'};
 let serial=0,calls=0;const receipts=new Map();
 const providers={verifyReconstructionPlan:async plan=>({planDigest:hash(plan),current:true}),executeReconstruction:async({claim})=>{calls++;const r=receipt(claim);receipts.set(claim.claimId,r);return r;},inspectReconstruction:async({claim})=>receipts.get(claim.claimId)??null,cancelReconstruction:async({claim})=>receipts.get(claim.claimId)??null,observeReconstruction:async({claim,receipt:r})=>observation(claim,r),...providerOverrides};
 let service=createRuntimeService(options,providers);service.initialize();
 const read=(operation,input={},s=scope)=>service.reconstruction({operation,scope:s,input});
 const request=async(operation,input={},extra={})=>({operation,scope,input,requestId:'reconstruction-'+(++serial),expectedRevision:(await read('reconstruction.inspect')).revision,...extra});
 const write=async(operation,input={},extra={})=>service.reconstruction(await request(operation,input,extra));
 const evidence=(operation,digest)=>syntheticDecisionEvidence(root,{owner:'runtime',operation,workspaceId:options.workspaceId,scope,reviewDigest:digest,decision:'APPROVE'});
 const planningWrite=async(operation,input)=>service.planning({operation,scope,input,requestId:'planning-'+(++serial),expectedRevision:(await service.planning({operation:'planning.inspect',scope,input:{}})).revision});
 const draft={title:'Synthetic controlled reconstruction',objective:'Prove bounded execution with synthetic input',sourceRevision:'synthetic-r1',sourceDigest:hash('source'),sources:[{id:'request',kind:'conversation',reference:'synthetic:test',representation:'excerpt',content:'Build a bounded example',contentDigest:nativeBytesDigest('Build a bounded example'),attributedRole:'user'}],items:[{id:'bounded',kind:'requirement',text:'Bound and retain execution',disposition:'included',sourceIds:['request'],dependsOn:[],ownerImpact:['runtime'],acceptance:['Retain the original claim']}],milestones:[{id:'t4',title:'Controlled reconstruction',targetVersion:'0.8.0',priority:1,requirementIds:['bounded'],dependsOn:[]}],exclusions:['No production'],candidates:[]};
 const planning=(await planningWrite('planning.revise',{id:'example-plan',parentDigest:null,draft})).result;
 await planningWrite('planning.decide',{id:planning.id,digest:planning.digest,decision:'APPROVE',actor:'synthetic-test-actor',humanEvidenceRef:evidence('planning.decide',planning.digest)});
 const plan={schema:'evopilot-reconstruction-plan/v1',workspaceId:options.workspaceId,scope,planning:{id:planning.id,digest:planning.digest,milestoneId:'t4'},...Object.fromEntries(['inventoryDigest','specificationDigest','oracleDigest','inputManifestDigest','environmentDigest','dependenciesDigest'].map(k=>[k,hash(k)])),executor:{id:'synthetic-local',version:'1',executableDigest:hash('binary'),configurationDigest:hash('configuration'),provider:'synthetic',model:'none'},inputMode:'ASSETS_ONLY',origin:'SYNTHETIC',independentConsumer:true,budget:{wallMs:5000,maxAttempts:4,maxOutputBytes:4096,maxTokens:100,maxCostMicros:100,maxIterations:2,...budget}};
 const freeze=async(value=plan)=>{const reviewed=await read('reconstruction.review',{plan:value});return (await write('reconstruction.freeze',{plan:value,humanEvidenceRef:evidence('reconstruction.freeze',reviewed.digest)})).result;};
 const binding=prepare?await freeze():null;
 const close=()=>service.close(),open=()=>{service=createRuntimeService(options,providers);service.initialize();return service;};
 t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,options,scope,plan,planning,draft,binding,providers,receipts,read,write,request,evidence,freeze,planningWrite,close,open,get service(){return service;},get calls(){return calls;}};
}
if(process.argv[2]==='interrupt'){
 const {options,request}=JSON.parse(process.argv[3]);
 const service=createRuntimeService(options,{verifyReconstructionPlan:async p=>({planDigest:hash(p),current:true}),executeReconstruction:async({claim})=>{process.send(claim);return new Promise(()=>{});},inspectReconstruction:async()=>null,cancelReconstruction:async()=>null});service.initialize();await service.reconstruction(request);
}
