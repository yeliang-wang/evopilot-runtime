import { exactFields, frozenClone, sha256, textField } from '../vendor/compatibility/v1/reference.mjs';
import { bounded, fail } from './state.mjs';
import { same, resolveMaterials } from './operations.mjs';

export function claimRun(store,state,run,providers) {
  if (run.claim || run.stage === 'CANCELLED') return false;
  if (typeof providers.execute !== 'function') fail('MISSING_EXECUTOR','Trusted execution adapter required');
  if (run.stage !== 'APPROVED' || run.decision?.decision !== 'APPROVE' || run.decision.reviewDigest !== run.reviewDigest) fail('APPROVAL_REQUIRED','Exact human approval required');
  const goal=state.goals.find(g=>same(g.scope,run.scope)&&g.id===run.plan.goal.id);
  if (!same(goal,run.plan.goal) || !same(resolveMaterials(providers,run.plan),run.plan.materials)) fail('PIN_DRIFT','Approved material or goal changed');
  const subject={workspace:store.identity,scope:run.scope,id:run.id,reviewDigest:run.reviewDigest,decision:run.decision,pins:run.plan.pins,inputDigest:sha256(run.plan.input)};
  const claimId=sha256(subject);
  run.claim={...subject,claimId,idempotencyKey:claimId,input:run.plan.input,materials:run.plan.materials,attemptCount:1}; run.attemptCount=1; run.stage='RUNNING'; return true;
}
export function receiptOutcome(value,claim) {
  try {
    bounded(value); exactFields(value,['claimId','inputDigest','pins','providerReceiptId','status','result']); textField(value.providerReceiptId);
    if (value.claimId!==claim.claimId || value.inputDigest!==claim.inputDigest || !same(value.pins,claim.pins) || !['SUCCEEDED','FAILED'].includes(value.status)) throw Error();
    exactFields(value.result,['evaluation','evidenceDigest']);
    if (!['PASS','FAIL','ERROR','INDETERMINATE','N/A','NOT_CHECKED','NOT_EVALUATED'].includes(value.result.evaluation) || !/^sha256:[a-f0-9]{64}$/.test(value.result.evidenceDigest)) throw Error();
    return {status:value.status,receipt:frozenClone(value),reason:null};
  } catch { return {status:'UNKNOWN',receipt:null,reason:'INVALID_PROVIDER_RECEIPT'}; }
}
export async function invoke(fn,claim,timeoutMs,controllers) {
  const controller=new AbortController(); controllers.add(controller);
  let timer;
  const stopped=new Promise(resolve=>{
    controller.signal.addEventListener('abort',()=>resolve({status:'UNKNOWN',receipt:null,reason:'INTERRUPTED'}),{once:true});
    timer=setTimeout(()=>controller.abort(),timeoutMs);
  });
  try {
    const call=Promise.resolve().then(()=>{ if(controller.signal.aborted) throw Error('Interrupted'); return fn(Object.freeze({...frozenClone(claim),signal:controller.signal})); }).then(value=>receiptOutcome(value,claim),()=>({status:'UNKNOWN',receipt:null,reason:'PROVIDER_UNAVAILABLE'}));
    return await Promise.race([call,stopped]);
  } finally { clearTimeout(timer); controllers.delete(controller); }
}
