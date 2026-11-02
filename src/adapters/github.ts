import { createHash } from 'node:crypto';
import { record, reject } from '../server/errors.js';
import type { PlatformRegistration } from './config.js';
import { commitId, fileBytes, jobResult, matchRepository, platformReader, positiveId, readinessResult, safePlatformError, sha256, type PlatformClient, type PlatformCredentialReader, type PlatformJobObservation } from './platforms.js';

/** GitHub.com REST observations. A successful old job is not evidence for a new
 * candidate or authority to dispatch another workflow. */
export function githubClient(configuration:PlatformRegistration,credentials:PlatformCredentialReader):PlatformClient{
  const{binding,get}=platformReader(configuration,credentials);if(binding.provider!=='github')reject('PLATFORM_MISMATCH','Expected GitHub registration');
  return Object.freeze({
    async readiness(actor,signal){try{
      matchRepository(await get(actor,'',signal),binding);
      const branch=record(await get(actor,'/branches/'+encodeURIComponent(binding.defaultBranch),signal));
      if(branch.name!==binding.defaultBranch)reject('PLATFORM_IDENTITY_CHANGED','Branch readback differs',409);
      const commit=commitId(record(branch.commit).sha),path=binding.workflowPath!;
      const workflow=record(await get(actor,'/actions/workflows/'+encodeURIComponent(path.split('/').at(-1)!),signal));
      if(workflow.path!==path||workflow.state!=='active')reject('WORKFLOW_NOT_READY','Registered workflow is absent or disabled',409);
      const file=record(await get(actor,'/contents/'+path+'?ref='+commit,signal));
      if(file.type!=='file'||file.path!==path||file.encoding!=='base64')reject('WORKFLOW_NOT_READY','Registered workflow is not a versioned file',409);
      const bytes=fileBytes(file.content,file.size),blob=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
      if(file.sha!==blob)reject('WORKFLOW_CONTENT_CHANGED','Workflow blob integrity check failed',409);
      return readinessResult(binding,commit,path,sha256(bytes),null);
    }catch(error){return safePlatformError(error);}},
    async job(actor,runId,jobId,commit,signal){try{
      positiveId(runId);positiveId(jobId);commitId(commit);
      matchRepository(await get(actor,'',signal),binding);
      const run=record(await get(actor,'/actions/runs/'+runId,signal)),job=record(await get(actor,'/actions/jobs/'+jobId,signal));
      if(positiveId(run.id)!==runId||positiveId(record(run.repository).id)!==binding.repositoryId||run.head_sha!==commit||run.head_branch!==binding.defaultBranch||run.path!==binding.workflowPath||positiveId(job.id)!==jobId||positiveId(job.run_id)!==runId||job.head_sha!==commit)reject('PLATFORM_RECEIPT_MISMATCH','GitHub observation does not match the exact repository/workflow/run/job/source',409);
      let status:PlatformJobObservation['status']='UNKNOWN';
      if(job.status==='queued'||job.status==='waiting'||job.status==='pending')status='PENDING';
      else if(job.status==='in_progress')status='RUNNING';
      else if(job.status==='completed')status=job.conclusion==='success'?'PASSED':['failure','cancelled','timed_out','action_required','startup_failure','skipped','neutral','stale'].includes(String(job.conclusion))?'FAILED':'UNKNOWN';
      return jobResult(binding,runId,jobId,commit,status,status==='UNKNOWN'?'unknown':String(job.status)+':'+(job.status==='completed'?String(job.conclusion):'pending'),typeof job.runner_id==='number'&&job.runner_id>0?positiveId(job.runner_id):null);
    }catch(error){return safePlatformError(error);}},
  } satisfies PlatformClient);
}
