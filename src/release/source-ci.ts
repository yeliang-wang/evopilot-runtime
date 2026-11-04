import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readArtifactArchive} from '../adapters/artifacts.js';

const repository='yeliang-wang/evopilot-runtime',repositoryId=1416265295;
const names=['SHA256SUMS','distribution-manifest.json','evopilot-next-runtime-0.9.0.tgz','evopilot-runtime-0.9.0-darwin-arm64.tar.gz','runtime-dependency-lock.json','source-revision.txt'].sort();
const sha=(b:Buffer|string):string=>createHash('sha256').update(b).digest('hex');
const requireValue=(v:unknown,message:string):void=>{if(!v)throw Error('SOURCE_CI_EVIDENCE: '+message);};
type ObjectValue=Record<string,unknown>;
const object=(v:unknown):ObjectValue=>{requireValue(v&&typeof v==='object'&&!Array.isArray(v),'Expected an object');return v as ObjectValue;};
const array=(v:unknown):unknown[]=>{requireValue(Array.isArray(v),'Expected an array');return v as unknown[];};
const parse=(b:Buffer):ObjectValue=>object(JSON.parse(b.toString()) as unknown);
const positive=(v:unknown):void=>requireValue(Number.isSafeInteger(v)&&Number(v)>0,'Invalid provider identifier');
const hash=(v:string):void=>requireValue(/^[a-f0-9]{64}$/.test(v),'Invalid expected SHA256');
export interface SourceCiRecords {
 sourceCommit:string;manifestDigest:string;archiveDigest:string;artifactDigest:string;
 run:unknown;jobs:unknown;artifact:unknown;jobLog:string;artifactZip:Buffer;
}

/** Verify original provider records and downloaded bytes. Callers must obtain
 * these records through the authenticated provider, retaining their original
 * digests. This pure integrity audit does not authenticate a caller's files,
 * substitute source tests for product E2E, or authorize a Release. */
export async function inspectSourceCiRecords(input:SourceCiRecords,signal:AbortSignal){
 requireValue(isDeepStrictEqual(Object.keys(input).sort(),['sourceCommit','manifestDigest','archiveDigest','artifactDigest','run','jobs','artifact','jobLog','artifactZip'].sort()),'Unexpected input fields');
 requireValue(/^[a-f0-9]{40}$/.test(input.sourceCommit),'Invalid source commit');
 for(const h of [input.manifestDigest,input.archiveDigest,input.artifactDigest])hash(h);
 const run=object(input.run),repo=object(run.repository),headRepo=object(run.head_repository);
 positive(run.id);positive(run.run_attempt);
 requireValue(repo.id===repositoryId&&repo.full_name===repository&&headRepo.id===repositoryId,'Foreign source repository');
 requireValue(run.head_sha===input.sourceCommit&&run.path==='.github/workflows/ci.yml'&&run.status==='completed'&&run.conclusion==='success','Wrong source, workflow or failed/incomplete run');
 requireValue(['push','workflow_dispatch','pull_request'].includes(String(run.event)),'Unsupported source event');
 const jobs=object(input.jobs),list=array(jobs.jobs).map(object);
 requireValue(jobs.total_count===list.length&&list.length===1,'Incomplete or changed source job collection');
 const job=list[0];positive(job.id);
 requireValue(job.name==='source'&&job.run_id===run.id&&job.run_attempt===run.run_attempt&&job.head_sha===input.sourceCommit&&job.status==='completed'&&job.conclusion==='success','Job identity/attempt differs from source CI');
 requireValue(isDeepStrictEqual(job.labels,['macos-15']),'Source job did not use the frozen macOS runner');
 const steps=array(job.steps).map(object),required=['Verify the declared source-test platform','Run npm ci --ignore-scripts','Run npm run build','Run npm run check','Run npm test','Pack exact candidate (not a Release)','Retain independently built candidate package'];
 requireValue(steps.length>0&&steps.every(s=>s.status==='completed'&&s.conclusion==='success'),'Skipped, failed or incomplete CI step');
 const positions=required.map(name=>{const found=steps.filter(s=>s.name===name);requireValue(found.length===1,'Missing or duplicate required CI step');return steps.indexOf(found[0]);});
 requireValue(positions.every((n,i)=>i===0||n>positions[i-1]),'Required CI step order changed');
 const artifact=object(input.artifact),workflow=object(artifact.workflow_run);positive(artifact.id);
 requireValue(artifact.name===`evopilot-runtime-${input.sourceCommit}-package`&&artifact.expired===false&&Date.parse(String(artifact.expires_at))>Date.now(),'Wrong or expired CI artifact');
 requireValue(workflow.id===run.id&&workflow.head_sha===input.sourceCommit&&workflow.repository_id===repositoryId&&workflow.head_repository_id===repositoryId,'Artifact belongs to another run/source');
 requireValue(artifact.url===`https://api.github.com/repos/${repository}/actions/artifacts/${String(artifact.id)}`&&artifact.archive_download_url===`https://api.github.com/repos/${repository}/actions/artifacts/${String(artifact.id)}/zip`,'Artifact URL differs from its immutable provider identity');
 requireValue(Buffer.isBuffer(input.artifactZip)&&artifact.size_in_bytes===input.artifactZip.length&&artifact.digest==='sha256:'+input.artifactDigest&&sha(input.artifactZip)===input.artifactDigest,'Downloaded CI archive differs from original metadata');
 requireValue(typeof input.jobLog==='string'&&Buffer.byteLength(input.jobLog)<=16777216,'Missing or excessive original job log');
 const log=input.jobLog.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /gm,'').replaceAll('\r\n','\n');
 const start='##[group]Run npm test\n',offset=log.indexOf(start);requireValue(offset>=0&&log.indexOf(start,offset+start.length)===-1,'Missing or ambiguous original npm test step');
 const next=log.indexOf('##[group]',offset+start.length);requireValue(next>offset,'Test step has no subsequent packaging step');
 const testLog=log.slice(offset,next),counts:Record<string,number>={};
 for(const key of ['tests','pass','fail','cancelled','skipped','todo']){
  const matches=[...testLog.matchAll(new RegExp('^(?:ℹ |# )'+key+' ([0-9]+)$','gm'))];requireValue(matches.length===1,'Missing or duplicate test count '+key);counts[key]=Number(matches[0][1]);
 }
 requireValue(Number.isSafeInteger(counts.tests)&&counts.tests>0&&counts.pass===counts.tests&&['fail','cancelled','skipped','todo'].every(k=>counts[k]===0),'Source tests are empty, failed or incomplete');
 requireValue(log.includes(`SHA256 digest of uploaded artifact zip is ${input.artifactDigest}\n`)&&log.includes(`Artifact ${String(artifact.name)}.zip successfully finalized. Artifact ID ${String(artifact.id)}\n`),'Artifact was not uploaded by this exact job attempt');
 const files=await readArtifactArchive(input.artifactZip,signal);requireValue(isDeepStrictEqual([...files.keys()].sort(),names),'CI distribution asset allowlist changed');
 const checksums=files.get('SHA256SUMS')!.toString();requireValue(checksums.endsWith('\n'),'Checksum list must have a final newline');
 const lines=checksums.slice(0,-1).split('\n'),checked=new Set<string>();
 requireValue(lines.length===names.length-1,'Incomplete checksum list');
 for(const line of lines){const m=/^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/.exec(line);requireValue(m&&!checked.has(m[2])&&m[2]!=='SHA256SUMS'&&files.has(m[2]),'Invalid or duplicate checksum entry');checked.add(m![2]);requireValue(sha(files.get(m![2])!)===m![1],'Distribution checksum changed');}
 requireValue(files.get('source-revision.txt')!.toString()===input.sourceCommit+'\n','Distribution source revision differs');
 const manifestBytes=files.get('distribution-manifest.json')!,manifest=parse(manifestBytes),archive=files.get('evopilot-runtime-0.9.0-darwin-arm64.tar.gz')!;
 requireValue(sha(manifestBytes)===input.manifestDigest&&manifest.schema==='runtime-standalone-distribution/v1'&&manifest.version==='0.9.0'&&manifest.archiveDigest===input.archiveDigest&&sha(archive)===input.archiveDigest,'Distribution differs from the accepted installed candidate');
 const inventory=Object.keys(object(manifest.files));requireValue(inventory.length>0&&inventory.length<=20000,'Empty or excessive package inventory');
 const lock=parse(files.get('runtime-dependency-lock.json')!);requireValue(lock.name==='@evopilot-next/runtime'&&lock.version==='0.9.0'&&lock.lockfileVersion===3,'Missing exact independent production dependency lock');
 return{schema:'runtime-source-ci-record-audit/v1' as const,sourceCommit:input.sourceCommit,runId:run.id,attempt:run.run_attempt,jobId:job.id,artifactId:artifact.id,artifactDigest:input.artifactDigest,manifestDigest:input.manifestDigest,archiveDigest:input.archiveDigest,counts,files:Object.fromEntries([...files].map(([name,bytes])=>[name,sha(bytes)])),jobLogDigest:sha(input.jobLog),recordIntegrity:'VERIFIED' as const,providerAuthentication:'CALLER_MUST_RETAIN_AUTHENTICATED_READS' as const,productAcceptance:'NOT_EVALUATED' as const,releaseAuthorized:false as const};
}
