import { createHash } from 'node:crypto';
import { canonical, exact, record, reject, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { valueDigest } from '../lifecycle/base.js';
import type { PlatformRegistration } from './config.js';
import { commitId, matchRepository, positiveId, sha256 } from './platforms.js';

export interface SourceOutput {path:string;digest:string;bytes:number;}
export interface SourceRequest {baselineCommit:string;commit:string;change:{kind:'pull-request'|'merge-request';id:string};artifacts:SourceOutput[];}
export interface SourceChange {path:string;previousPath:string|null;status:'added'|'modified'|'removed'|'renamed'|'changed';}
export interface SourceObservation {
  schema:'runtime-source-observation/v1'; provider:'github'|'gitlab';projectId:string;repositoryId:string;bindingDigest:string;
  baselineCommit:string;commit:string;change:SourceRequest['change'];state:'OPEN'|'CLOSED'|'MERGED';draft:boolean;
  sourceBranch:string;targetBranch:string;changes:SourceChange[];artifacts:SourceOutput[];
  evidenceRef:string;observedAt:string;factsDigest:string;sourceReviewApproved:false;ciVerified:false;releaseAuthorized:false;
}
type Get=(actor:Principal,path:string,signal:AbortSignal)=>Promise<unknown>;
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function path(value:unknown):string{
  const p=string(value,1024);if(p.startsWith('/')||p.includes('\\')||/[\u0000-\u001f\u007f]/.test(p)||p.split('/').some(s=>!s||s==='.'||s==='..'||s==='.git'))reject('SOURCE_PATH_INVALID','A canonical repository-relative file path is required');return p;
}
function request(value:SourceRequest,binding:PlatformRegistration):SourceRequest{
  const r=record(value);exact(r,['baselineCommit','commit','change','artifacts']);commitId(r.baselineCommit);commitId(r.commit);
  if(r.baselineCommit===r.commit)reject('SOURCE_UNCHANGED','Implementation needs an exact change from its reviewed baseline',409);
  const change=record(r.change);exact(change,['kind','id']);positiveId(change.id);
  if(change.kind!==(binding.provider==='github'?'pull-request':'merge-request'))reject('SOURCE_PROVIDER_MISMATCH','Change reference belongs to another provider',409);
  if(!Array.isArray(r.artifacts)||!r.artifacts.length||r.artifacts.length>128)reject('SOURCE_OUTPUT_LIMIT','A bounded submitted output inventory is required');
  const paths=new Set<string>();let total=0;
  for(const raw of r.artifacts){const a=record(raw);exact(a,['path','digest','bytes']);const p=path(a.path);if(paths.has(p))reject('SOURCE_OUTPUT_DUPLICATE','Submitted paths must be unique');paths.add(p);
    if(!/^sha256:[a-f0-9]{64}$/.test(string(a.digest,71))||!Number.isSafeInteger(a.bytes)||Number(a.bytes)<0||Number(a.bytes)>1048576||(total+=Number(a.bytes))>67108864)reject('SOURCE_OUTPUT_LIMIT','Remote verification supports at most 1 MiB per declared file and 64 MiB in total');
  }
  return JSON.parse(canonical(r)) as SourceRequest;
}
function bytes(value:unknown,size:unknown):Buffer{
  if(typeof value!=='string'||value.length>1400000||/[^A-Za-z0-9+/=\r\n]/.test(value)||!Number.isSafeInteger(size)||Number(size)<0||Number(size)>1048576)reject('SOURCE_CONTENT_INVALID','Invalid bounded source content',502);
  const encoded=value.replace(/[\r\n]/g,''),b=Buffer.from(encoded,'base64');if(b.length!==size||b.toString('base64')!==encoded)reject('SOURCE_CONTENT_INVALID','Source content encoding or size differs',502);return b;
}
function inventory(values:SourceChange[]):SourceChange[]{
  if(!values.length||values.length>1000||new Set(values.map(v=>v.path)).size!==values.length)reject('SOURCE_INVENTORY_INCOMPLETE','Complete unique change inventory is required',409);
  return values.sort((a,b)=>a.path.localeCompare(b.path));
}
/** Read-only exact-source verification. Provider identities are observations,
 * never Runtime principals, review decisions, successful CI or release grants. */
export function sourceReader(binding:PlatformRegistration,get:Get){
  return async(actor:Principal,value:SourceRequest,signal:AbortSignal):Promise<SourceObservation>=>{
    authorize(actor,binding.projectId,'read');const r=request(value,binding),github=binding.provider==='github';
    await get(actor,'',signal).then(v=>matchRepository(v,binding));
    const route=github?'/pulls/'+r.change.id:'/merge_requests/'+r.change.id;
    async function branch(){
      const b=record(await get(actor,(github?'/branches/':'/repository/branches/')+encodeURIComponent(binding.defaultBranch),signal));
      if(b.name!==binding.defaultBranch||record(b.commit)[github?'sha':'id']!==r.baselineCommit)reject('SOURCE_BASELINE_CHANGED','Target branch differs from the exact reviewed baseline',409);
    }
    function metadata(value:unknown){
      const m=record(value);let sourceBranch:string,state:SourceObservation['state'],draft:boolean;
      if(github){
        const base=record(m.base),head=record(m.head);
        if(positiveId(m.number)!==r.change.id||positiveId(record(base.repo).id)!==binding.repositoryId||positiveId(record(head.repo).id)!==binding.repositoryId||base.ref!==binding.defaultBranch||base.sha!==r.baselineCommit||head.sha!==r.commit||!['open','closed'].includes(String(m.state))||typeof m.merged!=='boolean'||typeof m.draft!=='boolean')reject('SOURCE_CHANGE_MISMATCH','Pull request differs from the exact repository/base/head',409);
        if(!Number.isSafeInteger(m.changed_files)||Number(m.changed_files)<1||Number(m.changed_files)>1000)reject('SOURCE_INVENTORY_INCOMPLETE','Exact complete pull request file count is required',409);
        sourceBranch=string(head.ref,256);state=m.merged?'MERGED':m.state==='open'?'OPEN':'CLOSED';draft=m.draft;
      }else{
        const refs=record(m.diff_refs);
        if(positiveId(m.iid)!==r.change.id||positiveId(m.project_id)!==binding.repositoryId||positiveId(m.source_project_id)!==binding.repositoryId||positiveId(m.target_project_id)!==binding.repositoryId||m.target_branch!==binding.defaultBranch||m.sha!==r.commit||refs.base_sha!==r.baselineCommit||refs.start_sha!==r.baselineCommit||refs.head_sha!==r.commit||!['opened','closed','merged'].includes(String(m.state))||typeof m.draft!=='boolean')reject('SOURCE_CHANGE_MISMATCH','Merge request differs from the exact repository/base/head',409);
        if(!/^[1-9]\d{0,3}$/.test(String(m.changes_count))||Number(m.changes_count)>1000)reject('SOURCE_INVENTORY_INCOMPLETE','Exact complete merge request file count is required',409);
        sourceBranch=string(m.source_branch,256);state=m.state==='merged'?'MERGED':m.state==='opened'?'OPEN':'CLOSED';draft=m.draft;
      }
      return{sourceBranch,targetBranch:binding.defaultBranch,state,draft,count:Number(github?m.changed_files:m.changes_count)};
    }
    await branch();const before=metadata(await get(actor,route,signal));let changes:SourceChange[]=[];
    if(github){
      const compare=record(await get(actor,'/compare/'+r.baselineCommit+'...'+r.commit+'?per_page=1',signal));
      if(compare.status!=='ahead'||compare.behind_by!==0||record(compare.base_commit).sha!==r.baselineCommit||record(compare.merge_base_commit).sha!==r.baselineCommit)reject('SOURCE_ANCESTRY_MISMATCH','Submitted source must descend from its reviewed baseline',409);
      let complete=false;
      for(let page=1;page<=11;page++){
        const rows=await get(actor,route+'/files?per_page=100&page='+page,signal);if(!Array.isArray(rows)||rows.length>100)reject('SOURCE_INVENTORY_INCOMPLETE','Invalid bounded pull request file inventory',502);
        for(const raw of rows){const f=record(raw),status=string(f.status);if(!['added','modified','removed','renamed','changed'].includes(status))reject('SOURCE_CHANGE_UNSUPPORTED','Unsupported source file change',409);changes.push({path:path(f.filename),previousPath:status==='renamed'?path(f.previous_filename):null,status:status as SourceChange['status']});}
        if(rows.length<100){complete=true;break;}if(changes.length>1000)break;
      }
      if(!complete)reject('SOURCE_INVENTORY_INCOMPLETE','Pull request file inventory exceeds its bounded profile',409);
    }else{
      // This endpoint is supported by the accepted GitLab 15.0 installation.
      // Its explicit overflow/count fields are mandatory; never accept a
      // truncated diff or silently switch to another API/version.
      const m=record(await get(actor,route+'/changes',signal));if(!same(metadata(m),before)||m.overflow!==false||!Array.isArray(m.changes))reject('SOURCE_INVENTORY_INCOMPLETE','Merge request changes are stale or truncated',409);
      for(const raw of m.changes){const f=record(raw);for(const k of ['new_file','deleted_file','renamed_file'])if(typeof f[k]!=='boolean')reject('SOURCE_INVENTORY_INCOMPLETE','File change flags are missing',409);
        if([f.new_file,f.deleted_file,f.renamed_file].filter(Boolean).length>1||f.too_large===true||f.collapsed===true)reject('SOURCE_INVENTORY_INCOMPLETE','Source change is contradictory or truncated',409);
        const status=f.deleted_file?'removed':f.renamed_file?'renamed':f.new_file?'added':'modified';
        if(!['0','100644','100755'].includes(String(f.a_mode))||!['0','100644','100755'].includes(String(f.b_mode))||!f.deleted_file&&f.b_mode==='0')reject('SOURCE_CHANGE_UNSUPPORTED','Linked/submodule source changes are not regular files',409);
        changes.push({path:path(f.deleted_file?f.old_path:f.new_path),previousPath:f.renamed_file?path(f.old_path):null,status});
      }
    }
    changes=inventory(changes);if(changes.length!==before.count)reject('SOURCE_INVENTORY_INCOMPLETE','Complete file inventory differs from provider count',409);
    for(const a of r.artifacts){
      if(!changes.some(c=>c.path===a.path&&c.status!=='removed'))reject('SOURCE_OUTPUT_MISMATCH','A declared output is absent from the exact change',409);
      const route=github?'/contents/'+a.path.split('/').map(encodeURIComponent).join('/')+'?ref='+r.commit:'/repository/files/'+encodeURIComponent(a.path)+'?ref='+r.commit;
      const f=record(await get(actor,route,signal));
      if(f.encoding!=='base64'||(github?(f.type!=='file'||f.path!==a.path||f.submodule_git_url!==undefined||f.target!==undefined):(f.file_path!==a.path||f.commit_id!==r.commit)))reject('SOURCE_OUTPUT_MISMATCH','Remote output is not the exact regular source file',409);
      const b=bytes(f.content,f.size),blob=createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');
      if((github?f.sha:f.blob_id)!==blob||!github&&'sha256:'+String(f.content_sha256)!==sha256(b)||b.length!==a.bytes||sha256(b)!==a.digest)reject('SOURCE_OUTPUT_MISMATCH','Remote source bytes differ from submitted output',409);
    }
    await branch();const after=metadata(await get(actor,route,signal));if(!same(before,after))reject('SOURCE_CHANGE_CHANGED','Source change moved during verification',409);signal.throwIfAborted();
    const facts={provider:binding.provider,projectId:binding.projectId,repositoryId:binding.repositoryId,bindingDigest:valueDigest(binding),baselineCommit:r.baselineCommit,commit:r.commit,change:r.change,state:before.state,draft:before.draft,sourceBranch:before.sourceBranch,targetBranch:before.targetBranch,changes,artifacts:r.artifacts};
    return{schema:'runtime-source-observation/v1',...facts,evidenceRef:binding.host+'/'+binding.repository+(github?'/pull/':'/-/merge_requests/')+r.change.id,observedAt:new Date().toISOString(),factsDigest:valueDigest(facts),sourceReviewApproved:false,ciVerified:false,releaseAuthorized:false};
  };
}
