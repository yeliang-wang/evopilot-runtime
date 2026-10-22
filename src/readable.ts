import {nativeSha256} from '../vendor/compatibility/v1/native.mjs';
import type {NativeProject,NativeRun,NativeRequest} from './native-types.js';
import type {PlanningEnvelope,PlanningBinding} from './planning.js';
import {readSnapshot,readFail} from '../vendor/readability/v1/readability.mjs';
import type {ReadScope,ReadSnapshot,ReadRow,ReadIdentity,JSONValue} from '../vendor/readability/v1/readability.mjs';
export async function runtimeReadSnapshot(workspaceId:string,scope:ReadScope,identity:ReadIdentity,access:{native(request:NativeRequest):Promise<unknown>;planning(request:PlanningEnvelope):Promise<unknown>}):Promise<ReadSnapshot>{
 const p=await access.native({operation:'project.inspect',scope,input:{id:identity.id}}) as NativeProject;
 const runId=identity.runId??p.complete?.runId??null;
 const run=runId?await access.native({operation:'run.inspect',scope,input:{id:runId}}) as NativeRun:null;
 if(run&&(run.plan.projectId!==p.id||nativeSha256(run.plan.scope)!==nativeSha256(scope)))readFail('READABLE_SCOPE');
 const ownerCriteria=run?.receipt?Object.values(run.receipt.ownerReceipts).flatMap(r=>r.criteria):[];
 const projectCheck=runId===p.complete?.runId?p.complete?.projectCheck??null:null;
 if(projectCheck){const {reportDigest,...body}=projectCheck;if(nativeSha256(body)!==reportDigest)readFail('READABLE_EVIDENCE_DRIFT');}
 const criteria=[...ownerCriteria,...(projectCheck?.criteria??[])];
 const rows:ReadRow[]=p.requirements.flatMap(q=>q.variantIds.map(v=>{
  const found=criteria.filter(c=>c.criterionId===q.criterionId&&c.variantId===v);if(found.length>1)readFail('READABLE_EVIDENCE_DRIFT');const c=found[0];
  return {id:'criterion:'+q.criterionId+':'+v,kind:'criterion',label:q.criterionId+' / '+v,expected:{status:'PASS'},actual:c?{status:c.status}:null,verdict:c?.status??'MISSING',origin:q.origin,references:[{kind:'criterion-evidence',id:q.criterionId+':'+v,digest:c?.evidenceDigest??null}],details:{runId,requirementOrigin:q.origin,evidenceBoundary:'Status concerns this fixed criterion only; consult owner case details to distinguish expected rejection from a valid business result'}};
 }));
 let binding:PlanningBinding|null=null,bindingCurrent:boolean|null=null;
 try{const result=await access.planning({operation:'planning.binding.inspect',scope,input:{projectId:p.id}}) as {binding:PlanningBinding;current:boolean;blocker:string|null};binding=result.binding;bindingCurrent=result.current;
 rows.push({id:'planning:'+binding.planId,kind:'planning',label:binding.planId+' / '+binding.milestoneId,verdict:result.current?'CURRENT':'STALE',expected:{planDigest:binding.planDigest},actual:{current:result.current,blocker:result.blocker},origin:'human-reviewed-planning',references:[{kind:'planning-revision',id:binding.planId,digest:binding.planDigest}],details:{goalId:binding.goalId,milestoneId:binding.milestoneId,sourceRevision:binding.sourceRevision,sourceDigest:binding.sourceDigest,assetPins:binding.assets} as unknown as JSONValue});
 }catch(e){if((e as {code?:string}).code!=='PLANNING_NOT_FOUND')throw e;}
 const latest=await access.native({operation:'project.inspect',scope,input:{id:p.id}}) as NativeProject;
 if(nativeSha256(latest)!==nativeSha256(p))readFail('READABLE_SNAPSHOT_DRIFT');
 if(run&&nativeSha256(await access.native({operation:'run.inspect',scope,input:{id:run.plan.id}}))!==nativeSha256(run))readFail('READABLE_SNAPSHOT_DRIFT');
 return readSnapshot({owner:'runtime',workspaceId,scope,subject:{kind:'project',id:p.id,version:null},pins:{projectCandidateDigest:p.candidateDigest,sourceRevision:p.sourceScope.revision,sourceDigest:p.sourceScope.treeDigest,requirementSetDigest:p.sourceScope.requirementsDigest,runDigest:run?nativeSha256(run):null,ontologyDigest:run?.plan.pins.ontology.digest??null,harnessDigest:run?.plan.pins.harness.digest??null,planDigest:binding?.planDigest??null},rows,
 denominator:{requirements:p.requirements.length,variants:p.requirements.reduce((n,q)=>n+q.variantIds.length,0)},
 stages:[{id:'planning',status:binding?(bindingCurrent?'CURRENT':'STALE'):'UNBOUND',reason:'Planning baseline is separate from execution approval'},
 {id:'validation-run',status:run?.stage??'NOT_EXECUTED',reason:runId?'Selected exact Run '+runId:'No Run selected or completed'},
 {id:'execution-decision',status:run?.decision?.decision??'PENDING',reason:'Decision applies only to the exact Run'},
 {id:'project-completion',status:p.complete?'RECORDED':'INCOMPLETE',reason:'Fixed contract completion does not certify undeclared business, Host or scale obligations'},
 {id:'software-release',status:'NOT_ASSERTED',reason:'No software release authority comes from this view'}],
 limitations:['Original fixed denominator is retained including MISSING criteria','Undeclared business end-to-end, Host and scale acceptance is not inferred from asset tests','This is a verified owner snapshot, not a multi-owner transactional snapshot']});
}
