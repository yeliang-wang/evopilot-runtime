import { createHash } from 'node:crypto';
import { evidenceValueDigest, exact, record, reject, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { valueDigest } from '../lifecycle/base.js';
import { containsInlineSecret } from '../lifecycle/compiler.js';
import type { PlatformRegistration } from './config.js';
import { commitId, matchRepository, sha256 } from './platforms.js';

export interface ReleaseDocument {role:'release-notes'|'migration'|'readme'|'technical';path:string;}
export interface DocumentObservation {
  schema:'runtime-release-documents/v1';provider:'github'|'gitlab';projectId:string;repositoryId:string;
  bindingDigest:string;commit:string;documents:(ReleaseDocument&{digest:string;bytes:number;text:string})[];
  factsDigest:string;observedAt:string;releaseAuthorized:false;
}
type Get=(actor:Principal,path:string,signal:AbortSignal)=>Promise<unknown>;
const roles=['release-notes','migration','readme','technical'];
export function releaseDocuments(value:unknown):ReleaseDocument[]{
  if(!Array.isArray(value)||value.length<4||value.length>16)reject('RELEASE_DOCUMENT_CONFIGURATION','Configure 4–16 explicit required release documents',409);
  const keys=new Set<string>(),found=new Set<string>();
  const docs=value.map(raw=>{
    const d=record(raw);exact(d,['role','path']);const role=string(d.role),path=string(d.path,512),parts=path.split('/');
    if(!roles.includes(role)||path.startsWith('/')||path.includes('\\')||/[\u0000-\u001f\u007f]/.test(path)||parts.length>8||parts.some(s=>!s||s==='.'||s==='..'||s==='.git')||!/[.](?:md|markdown|txt)$/i.test(path))reject('RELEASE_DOCUMENT_CONFIGURATION','Use a supported document role and bounded repository-relative text path',409);
    const key=role+'\0'+path;if(keys.has(key))reject('RELEASE_DOCUMENT_CONFIGURATION','Duplicate release document mapping',409);keys.add(key);found.add(role);return{role:role as ReleaseDocument['role'],path};
  });
  if(roles.some(role=>!found.has(role)))reject('RELEASE_DOCUMENT_CONFIGURATION','Release notes, migration, README and technical-document mappings are all required',409);
  return docs.sort((a,b)=>(a.role+'\0'+a.path).localeCompare(b.role+'\0'+b.path));
}
/** Fixed read-only source paths. Tree modes reject links/submodules before
 * bytes are retained; neither a branch HEAD nor an arbitrary URL is followed. */
export function documentReader(binding:PlatformRegistration,get:Get){
  return async(actor:Principal,input:{commit:string;documents:ReleaseDocument[]},signal:AbortSignal):Promise<DocumentObservation>=>{
    authorize(actor,binding.projectId,'read');exact(record(input),['commit','documents']);const commit=commitId(input.commit),documents=releaseDocuments(input.documents),github=binding.provider==='github';
    matchRepository(await get(actor,'',signal),binding);
    const c=record(await get(actor,(github?'/git/commits/':'/repository/commits/')+commit,signal));
    if(c[github?'sha':'id']!==commit)reject('RELEASE_DOCUMENT_SOURCE','Exact candidate source commit is unavailable',409);
    const root=github?commitId(record(c.tree).sha):'',cache=new Map<string,Promise<Record<string,unknown>[]>>();
    async function tree(parent:string,sha:string):Promise<Record<string,unknown>[]>{
      const key=github?sha:parent;if(cache.has(key))return cache.get(key)!;
      const task=(async()=>{
        if(github){const t=record(await get(actor,'/git/trees/'+sha,signal));if(t.sha!==sha||t.truncated!==false||!Array.isArray(t.tree)||t.tree.length>1000)reject('RELEASE_DOCUMENT_TREE','A complete bounded source tree is required',409);return t.tree.map(record);}
        const rows:Record<string,unknown>[]=[];
        for(let page=1;page<=10;page++){
          const values=await get(actor,'/repository/tree?ref='+commit+'&path='+encodeURIComponent(parent)+'&per_page=100&page='+page,signal);
          if(!Array.isArray(values)||values.length>100)reject('RELEASE_DOCUMENT_TREE','Invalid bounded repository tree',409);
          rows.push(...values.map(record));if(values.length<100)return rows;
        }
        reject('RELEASE_DOCUMENT_TREE','Repository directory exceeds the complete bounded inventory',409);
      })();cache.set(key,task);return task;
    }
    const contents=new Map<string,{digest:string;bytes:number;text:string}>();let total=0;
    for(const d of documents){
      if(contents.has(d.path))continue;
      let parent='',treeSha=root,entry:Record<string,unknown>|undefined;const parts=d.path.split('/');
      for(let i=0;i<parts.length;i++){
        const rows=await tree(parent,treeSha),full=parent?parent+'/'+parts[i]:parts[i],matches=rows.filter(r=>r.path===(github?parts[i]:full));
        if(matches.length!==1)reject('RELEASE_DOCUMENT_MISSING','Exact release document path is missing or ambiguous',409);entry=matches[0]!;
        if(i<parts.length-1){if(entry.type!=='tree'||entry.mode!=='040000')reject('RELEASE_DOCUMENT_TYPE','Release document parents must be regular Git trees',409);treeSha=commitId(entry[github?'sha':'id']);parent=full;}
        else if(entry.type!=='blob'||!['100644','100755'].includes(String(entry.mode)))reject('RELEASE_DOCUMENT_TYPE','Release documents cannot be links or submodules',409);
      }
      const route=github?'/contents/'+parts.map(encodeURIComponent).join('/')+'?ref='+commit:'/repository/files/'+encodeURIComponent(d.path)+'?ref='+commit;
      const f=record(await get(actor,route,signal));
      if(f.encoding!=='base64'||(github?(f.type!=='file'||f.path!==d.path||f.target!==undefined||f.submodule_git_url!==undefined):(f.file_path!==d.path||f.commit_id!==commit))||typeof f.content!=='string'||f.content.length>1400000||/[^A-Za-z0-9+/=\r\n]/.test(f.content)||!Number.isSafeInteger(f.size)||Number(f.size)<1||Number(f.size)>1048576)reject('RELEASE_DOCUMENT_CONTENT','A bounded nonempty regular source document is required',409);
      const encoded=f.content.replace(/[\r\n]/g,''),bytes=Buffer.from(encoded,'base64'),blob=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
      if(bytes.length!==f.size||bytes.toString('base64')!==encoded||f[github?'sha':'blob_id']!==blob||entry![github?'sha':'id']!==blob||!github&&'sha256:'+String(f.content_sha256)!==sha256(bytes)||(total+=bytes.length)>8388608)reject('RELEASE_DOCUMENT_CONTENT','Document content must match the exact Git blob within 8 MiB total',409);
      let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return reject('RELEASE_DOCUMENT_CONTENT','Release documentation must be UTF-8 text',409);}
      if(!text.trim()||text.includes('\0')||containsInlineSecret(text))reject('RELEASE_DOCUMENT_CONTENT','Release documentation must be nonempty text without raw credential material',409);
      contents.set(d.path,{text,bytes:bytes.length,digest:sha256(bytes)});
    }
    signal.throwIfAborted();const facts={provider:binding.provider,projectId:binding.projectId,repositoryId:binding.repositoryId,bindingDigest:valueDigest(binding),commit,documents:documents.map(d=>({...d,...contents.get(d.path)!}))};
    return{schema:'runtime-release-documents/v1',...facts,factsDigest:evidenceValueDigest(facts),observedAt:new Date().toISOString(),releaseAuthorized:false};
  };
}
