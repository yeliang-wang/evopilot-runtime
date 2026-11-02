import {canonical,exact,record,reject,ServiceError,string} from '../server/errors.js';
import {authorize,type Principal} from '../server/security.js';
import {byteDigest,valueDigest} from '../lifecycle/base.js';
import {candidateDigest,type CandidateManifest} from '../lifecycle/instance.js';
import type {PlatformRegistration} from './config.js';
import {commitId,matchRepository,positiveId} from './platforms.js';
import {MAX_ARCHIVE_BYTES} from './artifacts.js';
import type {PlatformRunRequest} from './platforms.js';

export interface PublicationTarget {tagPrefix:''|'v';prerelease:boolean;packageName:string|null;}
export interface PublicationInput {
  schema:'runtime-publication-input/v1';target:PublicationTarget;tag:string;releaseMaterialDigest:string;releaseAuthorityRef:string;
  notes:{path:string;digest:string;bytes:number}[];
}
export function validatePublicationInput(input:PublicationInput,request:Pick<PlatformRunRequest,'candidateInput'|'stageId'>,provider:'github'|'gitlab'):PublicationInput{
  const p=record(input);exact(p,['schema','target','tag','releaseMaterialDigest','releaseAuthorityRef','notes']);const target=publicationTarget(p.target,provider);
  if(p.schema!=='runtime-publication-input/v1'||request.stageId!=='publication'||!request.candidateInput||publicationTag(request.candidateInput.manifest.version,target)!==p.tag||!/^sha256:[a-f0-9]{64}$/.test(string(p.releaseMaterialDigest,71))||!/^authority:sha256:[a-f0-9]{64}$/.test(string(p.releaseAuthorityRef,81))||!Array.isArray(p.notes)||!p.notes.length||p.notes.length>16||Buffer.byteLength(canonical(p))>16384)reject('PUBLICATION_INPUT','Publication requires exact reviewed material, authority and bounded note references',409);
  const paths=new Set<string>();for(const raw of p.notes){const n=record(raw);exact(n,['path','digest','bytes']);const path=string(n.path,512);if(path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||['.','..','.git'].includes(p))||!/[.](md|markdown|txt)$/i.test(path)||paths.has(path)||!/^sha256:[a-f0-9]{64}$/.test(string(n.digest,71))||!Number.isSafeInteger(n.bytes)||Number(n.bytes)<1||Number(n.bytes)>1048576)reject('PUBLICATION_INPUT','Invalid exact release-note reference',409);paths.add(path);}
  const descriptionBytes=input.notes.reduce((sum,n)=>sum+n.bytes,0)+(input.notes.length-1)*2+Buffer.byteLength('\n\n<!-- evopilot-runtime-publication:sha256:'+'0'.repeat(64)+' -->');
  if(descriptionBytes>65536)reject('PUBLICATION_NOTES_LIMIT','Combined public release notes exceed the 64 KiB provider profile',409);
  return input;
}
export function publicationDescription(notes:readonly string[],request:PlatformRunRequest):string{
  const marker=valueDigest({requestId:request.requestId,inputDigest:request.inputDigest,commit:request.commit,candidateDigest:request.candidateDigest,publicationInput:request.publicationInput});
  const description=notes.join('\n\n')+'\n\n<!-- evopilot-runtime-publication:'+marker+' -->';
  if(Buffer.byteLength(description)>65536)reject('PUBLICATION_NOTES_LIMIT','Combined public release notes exceed the 64 KiB provider profile',409);return description;
}
export interface DistributionRequest {
  commit:string;candidate:CandidateManifest;tag:string;prerelease:boolean;packageName:string|null;descriptionDigest:string;
}
export interface DistributionArtifact {name:string;id:string|null;status:'PASSED'|'UNKNOWN'|'MISMATCH';digest:string|null;bytes:number|null;reason:string|null;}
export interface DistributionObservation {
  schema:'runtime-distribution-observation/v1';provider:'github'|'gitlab';projectId:string;repositoryId:string;bindingDigest:string;
  candidateDigest:string;commit:string;tag:string;status:'ABSENT'|'PARTIAL'|'MISMATCH'|'PASSED';releaseObserved:boolean;
  release:{id:string;tag:string;commit:string;descriptionDigest:string;metadataDigest:string}|null;
  artifacts:DistributionArtifact[];reasons:string[];factsDigest:string;observedAt:string;releaseAuthorized:false;
}
type Get=(actor:Principal,path:string,signal:AbortSignal)=>Promise<unknown>;
type Download=(actor:Principal,path:string,signal:AbortSignal)=>Promise<Buffer>;
export function publicationTarget(value:unknown,provider:'github'|'gitlab'):PublicationTarget{
  const v=record(value);exact(v,['tagPrefix','prerelease','packageName']);
  if(!['','v'].includes(String(v.tagPrefix))||typeof v.prerelease!=='boolean'||(provider==='github'?v.packageName!==null:typeof v.packageName!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v.packageName)||v.packageName.includes('..')))reject('PUBLICATION_CONFIGURATION','Configure an exact tag prefix, prerelease flag and provider package name',409);
  return v as unknown as PublicationTarget;
}
export function publicationTag(version:string,target:PublicationTarget):string{
  if(!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version)||version.includes('..')||version.endsWith('.'))reject('PUBLICATION_VERSION','A fixed provider-safe candidate version is required',409);return target.tagPrefix+version;
}
/** Same-project Generic Package route, available on GitLab 15.0. Never a URL
 * supplied by a release link. The actual link must equal this derived route. */
export function genericPackagePath(name:string,version:string,file:string):string{return'/packages/generic/'+[name,version,file].map(encodeURIComponent).join('/');}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export function distributionReader(binding:PlatformRegistration,get:Get,download:Download){
  return async(actor:Principal,input:DistributionRequest,signal:AbortSignal):Promise<DistributionObservation>=>{
    authorize(actor,binding.projectId,'read');signal.throwIfAborted();exact(record(input),['commit','candidate','tag','prerelease','packageName','descriptionDigest']);
    const commit=commitId(input.commit),digest=candidateDigest(input.candidate),gh=binding.provider==='github',target=publicationTarget({tagPrefix:input.tag===input.candidate.version?'':'v',prerelease:input.prerelease,packageName:input.packageName},binding.provider);
    if(publicationTag(input.candidate.version,target)!==input.tag||input.candidate.sourceDigest!==valueDigest({provider:binding.provider,repositoryId:binding.repositoryId,commit})||!/^sha256:[a-f0-9]{64}$/.test(string(input.descriptionDigest,71))||input.candidate.artifacts.some(a=>a.bytes>MAX_ARCHIVE_BYTES)||input.candidate.artifacts.reduce((s,a)=>s+a.bytes,0)>256*1024*1024)reject('DISTRIBUTION_SCOPE','Exact candidate source, bounded artifacts and release description are required',409);
    matchRepository(await get(actor,'',signal),binding);
    const route='/releases/'+(gh?'tags/':'')+encodeURIComponent(input.tag),reasons:string[]=[],artifacts:DistributionArtifact[]=[];
    let release:DistributionObservation['release']=null,releaseObserved=false;
    function result(status:DistributionObservation['status']):DistributionObservation{
      const facts={provider:binding.provider,projectId:binding.projectId,repositoryId:binding.repositoryId,bindingDigest:valueDigest(binding),candidateDigest:digest,commit,tag:input.tag,status,releaseObserved,release,artifacts,reasons};
      return{schema:'runtime-distribution-observation/v1',...facts,factsDigest:valueDigest(facts),observedAt:new Date().toISOString(),releaseAuthorized:false};
    }
    async function list(path:string):Promise<Record<string,unknown>[]>{
      const rows:Record<string,unknown>[]=[];
      for(let page=1;page<=10;page++){
        const v=await get(actor,path+(path.includes('?')?'&':'?')+'per_page=100&page='+page,signal);
        if(!Array.isArray(v)||v.length>100)reject('DISTRIBUTION_INVENTORY','Invalid bounded release inventory',409);rows.push(...v.map(record));if(v.length<100)return rows;
      }
      reject('DISTRIBUTION_INVENTORY','Complete release inventory exceeded its bound',409);
    }
    async function snapshot(){
      const raw=record(await get(actor,route,signal));releaseObserved=true;let source:string;
      if(gh){
        const ref=record(await get(actor,'/git/ref/tags/'+encodeURIComponent(input.tag),signal));
        if(ref.ref!=='refs/tags/'+input.tag)reject('DISTRIBUTION_TAG','Release tag differs',409);
        let object=record(ref.object),depth=0;const seen=new Set<string>();
        while(object.type==='tag'){
          const sha=commitId(object.sha);if(seen.has(sha)||++depth>4)reject('DISTRIBUTION_TAG','Annotated release tag chain exceeds its bound',409);seen.add(sha);
          const tag=record(await get(actor,'/git/tags/'+sha,signal));if(tag.sha!==sha)reject('DISTRIBUTION_TAG','Annotated tag identity differs',409);object=record(tag.object);
        }
        if(object.type!=='commit')reject('DISTRIBUTION_TAG','Release tag must resolve to a commit',409);source=commitId(object.sha);
      }else source=commitId(record(raw.commit).id);
      const id=gh?positiveId(raw.id):String(raw.tag_name),body=raw[gh?'body':'description'];
      if(raw.tag_name!==input.tag||typeof body!=='string'||Buffer.byteLength(body)>1048576||gh&&(raw.draft!==false||raw.prerelease!==input.prerelease)||!gh&&raw.upcoming_release===true||!Number.isFinite(Date.parse(String(raw[gh?'published_at':'released_at'])))||Date.parse(String(raw[gh?'published_at':'released_at']))>Date.now())reject('DISTRIBUTION_RELEASE','Exact published release metadata is required',409);
      const links=await list(gh?'/releases/'+id+'/assets':route+'/assets/links');
      const entries=links.map(a=>gh?{id:positiveId(a.id),name:a.name,state:a.state,size:a.size,digest:a.digest??null}:{id:positiveId(a.id),name:a.name,url:a.url}).sort((a,b)=>a.id.localeCompare(b.id));
      const meta={id,tag:input.tag,commit:source,descriptionDigest:byteDigest(body),publishedAt:raw[gh?'published_at':'released_at'],prerelease:gh?raw.prerelease:input.prerelease,entries};
      return{release:{id,tag:input.tag,commit:source,descriptionDigest:meta.descriptionDigest,metadataDigest:valueDigest(meta)},entries};
    }
    let before:Awaited<ReturnType<typeof snapshot>>;
    try{before=await snapshot();release=before.release;}catch(e){if(e instanceof ServiceError&&e.code==='PLATFORM_RESOURCE_MISSING'){reasons.push(e.code);return result(releaseObserved?'PARTIAL':'ABSENT');}throw e;}
    if(release.commit!==commit||release.descriptionDigest!==input.descriptionDigest){reasons.push('DISTRIBUTION_RELEASE_MISMATCH');return result('MISMATCH');}
    const names=input.candidate.artifacts.map(a=>a.name),entries=before.entries;
    if(entries.length!==names.length||new Set(entries.map(a=>a.name)).size!==entries.length||entries.some(a=>!names.includes(String(a.name)))){reasons.push('DISTRIBUTION_INVENTORY_MISMATCH');return result('PARTIAL');}
    let packageId:string|null=null,packageFiles:Record<string,unknown>[]=[];
    async function packageSnapshot(){
      const packages=await list('/packages?package_type=generic&package_name='+encodeURIComponent(input.packageName!)),matching=packages.filter(p=>p.name===input.packageName&&p.version===input.candidate.version&&p.package_type==='generic');
      if(matching.length!==1)reject('DISTRIBUTION_PACKAGE','Exactly one same-project package version is required',409);
      const pkg=matching[0]!,id=positiveId(pkg.id);if(pkg.status!=='default')reject('DISTRIBUTION_PACKAGE','Published package is not available',409);
      const files=await list('/packages/'+id+'/package_files');
      if(files.length!==names.length||new Set(files.map(f=>f.file_name)).size!==files.length||files.some(f=>!names.includes(String(f.file_name))))reject('DISTRIBUTION_PACKAGE','Package file inventory is incomplete or ambiguous',409);
      return{id,files:files.map(f=>({id:positiveId(f.id),file_name:f.file_name,size:f.size,file_sha256:f.file_sha256})).sort((a,b)=>a.id.localeCompare(b.id))};
    }
    if(!gh){try{const p=await packageSnapshot();packageId=p.id;packageFiles=p.files;}catch(e){reasons.push(e instanceof ServiceError?e.code:'DISTRIBUTION_UNAVAILABLE');return result('PARTIAL');}}
    for(const expected of input.candidate.artifacts){
      const entry=entries.find(a=>a.name===expected.name)!,fact:DistributionArtifact={name:expected.name,id:entry.id,status:'UNKNOWN',digest:null,bytes:null,reason:null};artifacts.push(fact);
      try{
        signal.throwIfAborted();let path:string;
        if(gh){
          const e=entry as {id:string;state:unknown;size:unknown;digest:unknown};
          if(e.state!=='uploaded'||e.size!==expected.bytes||e.digest!==null&&e.digest!==expected.digest)reject('DISTRIBUTION_ASSET','Release asset metadata differs from the candidate',409);
          path='/releases/assets/'+e.id;
        }else{
          path=genericPackagePath(input.packageName!,input.candidate.version,expected.name);
          if((entry as {url:unknown}).url!==binding.host+'/api/v4/projects/'+binding.repositoryId+path)reject('DISTRIBUTION_LINK','Release link must point at the configured same-project package file',409);
          const f=packageFiles.find(f=>f.file_name===expected.name)!;
          if(f.size!==expected.bytes||'sha256:'+String(f.file_sha256)!==expected.digest)reject('DISTRIBUTION_ASSET','Package file metadata differs from the candidate',409);
          fact.id=packageId+':'+String(f.id);
        }
        const bytes=await download(actor,path,signal);fact.bytes=bytes.length;fact.digest=byteDigest(bytes);
        if(fact.bytes!==expected.bytes||fact.digest!==expected.digest)reject('DISTRIBUTION_DIGEST','Downloaded artifact differs from the approved candidate',409);fact.status='PASSED';
      }catch(e){fact.reason=e instanceof ServiceError?e.code:'DISTRIBUTION_UNAVAILABLE';fact.status=['DISTRIBUTION_ASSET','DISTRIBUTION_LINK','DISTRIBUTION_DIGEST'].includes(fact.reason)?'MISMATCH':'UNKNOWN';}
    }
    try{
      signal.throwIfAborted();const after=await snapshot();if(!same(after,before))reject('DISTRIBUTION_CHANGED','Release identity or assets changed during readback',409);
      if(!gh&&!same(await packageSnapshot(),{id:packageId,files:packageFiles}))reject('DISTRIBUTION_CHANGED','Package identity changed during download',409);
    }catch(e){reasons.push(e instanceof ServiceError?e.code:'DISTRIBUTION_UNAVAILABLE');}
    return result(artifacts.some(a=>a.status==='MISMATCH')||reasons.includes('DISTRIBUTION_CHANGED')?'MISMATCH':reasons.length||artifacts.some(a=>a.status!=='PASSED')?'PARTIAL':'PASSED');
  };
}
