import { record, reject } from '../server/errors.js';
import type { PlatformRegistration } from './config.js';
import { commitId, fileBytes, jobResult, matchRepository, platformReader, positiveId, readinessResult, safePlatformError, sha256, type PlatformClient, type PlatformCredentialReader, type PlatformJobObservation } from './platforms.js';

/** GitLab v4 API, including the accepted self-managed 15.0 test instance. Only
 * explicit registered project/runner IDs are used; no admin runner discovery. */
export function gitlabClient(configuration:PlatformRegistration,credentials:PlatformCredentialReader):PlatformClient{
  const{binding,get}=platformReader(configuration,credentials);if(binding.provider!=='gitlab')reject('PLATFORM_MISMATCH','Expected GitLab registration');
  return Object.freeze({
    async readiness(actor,signal){try{
      const project=matchRepository(await get(actor,'',signal),binding);
      if(project.jobs_enabled!==true||(project.ci_config_path||'.gitlab-ci.yml')!==binding.pipelinePath)reject('WORKFLOW_NOT_READY','CI is disabled or its registered path differs',409);
      const branch=record(await get(actor,'/repository/branches/'+encodeURIComponent(binding.defaultBranch),signal));
      if(branch.name!==binding.defaultBranch)reject('PLATFORM_IDENTITY_CHANGED','Branch readback differs',409);
      const commit=commitId(record(branch.commit).id),path=binding.pipelinePath!;
      const file=record(await get(actor,'/repository/files/'+encodeURIComponent(path)+'?ref='+commit,signal));
      if(file.file_path!==path||file.encoding!=='base64'||file.commit_id!==commit)reject('WORKFLOW_NOT_READY','Pipeline file does not match the exact source revision',409);
      const bytes=fileBytes(file.content,file.size);if(sha256(bytes)!=='sha256:'+String(file.content_sha256))reject('WORKFLOW_CONTENT_CHANGED','Pipeline content integrity check failed',409);
      let runner:Record<string,unknown>|undefined;
      // Bound pagination, fail closed instead of mistaking a truncated list for
      // proof. A large installation should use a dedicated test project.
      for(let page=1;page<=10;page++){
        const list=await get(actor,'/runners?per_page=100&page='+page,signal);if(!Array.isArray(list)||list.length>100)reject('PLATFORM_RESPONSE_INVALID','Invalid project runner list',502);
        runner=list.map(record).find(r=>positiveId(r.id)===binding.runner);if(runner||list.length<100)break;
      }
      if(!runner||runner.active!==true||runner.paused===true||runner.online!==true||runner.status!=='online')reject('RUNNER_NOT_READY','Registered project runner is unavailable, paused or offline',409);
      return readinessResult(binding,commit,path,sha256(bytes),{id:binding.runner!,online:true});
    }catch(error){return safePlatformError(error);}},
    async job(actor,runId,jobId,commit,signal){try{
      positiveId(runId);positiveId(jobId);commitId(commit);
      matchRepository(await get(actor,'',signal),binding);
      const pipeline=record(await get(actor,'/pipelines/'+runId,signal)),job=record(await get(actor,'/jobs/'+jobId,signal));
      if(positiveId(pipeline.id)!==runId||positiveId(pipeline.project_id)!==binding.repositoryId||pipeline.sha!==commit||pipeline.ref!==binding.defaultBranch||positiveId(job.id)!==jobId||positiveId(record(job.pipeline).id)!==runId||record(job.commit).id!==commit)reject('PLATFORM_RECEIPT_MISMATCH','GitLab observation does not match the exact repository/pipeline/job/source',409);
      const runner=job.runner===null?null:record(job.runner),runnerId=runner?positiveId(runner.id):null;
      if(runnerId!==null&&runnerId!==binding.runner)reject('PLATFORM_RECEIPT_MISMATCH','Job used a different registered runner',409);
      let status:PlatformJobObservation['status']='UNKNOWN';
      if(['created','pending','preparing','waiting_for_resource','scheduled','manual'].includes(String(job.status)))status='PENDING';
      else if(job.status==='running')status='RUNNING';
      else if(job.status==='success'&&runnerId!==null)status='PASSED';
      else if(['failed','canceled','skipped'].includes(String(job.status)))status='FAILED';
      return jobResult(binding,runId,jobId,commit,status,status==='UNKNOWN'?'unknown':String(job.status),runnerId);
    }catch(error){return safePlatformError(error);}},
  } satisfies PlatformClient);
}
