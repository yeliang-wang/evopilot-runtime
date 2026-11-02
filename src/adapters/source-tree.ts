import {createHash} from 'node:crypto';
import {exact,record,reject,string} from '../server/errors.js';
import {authorize,type Principal} from '../server/security.js';
import {valueDigest} from '../lifecycle/base.js';
import type {PlatformRegistration} from './config.js';
import {commitId,matchRepository} from './platforms.js';

export interface SourceTreeEntry {path:string;type:'tree'|'blob'|'commit';mode:'040000'|'100644'|'100755'|'120000'|'160000';objectId:string;}
export interface SourceTreeObservation {
  schema:'runtime-source-tree/v1';provider:'github'|'gitlab';projectId:string;repositoryId:string;
  bindingDigest:string;commit:string;rootTreeId:string;entries:SourceTreeEntry[];
  inventoryDigest:string;treeDigest:string;factsDigest:string;observedAt:string;
  contentRead:false;linksFollowed:false;sourceApproved:false;
}
type Get=(actor:Principal,path:string,signal:AbortSignal)=>Promise<unknown>;
const MAX_ENTRIES=16384,MAX_DIRECTORIES=256,MAX_REQUESTS=512,MAX_DIRECTORY_ENTRIES=1000;
function name(value:unknown):string{
  const s=string(value,255);
  if(s!==s.normalize('NFC')||s==='.'||s==='..'||s==='.git'||/[\\/\u0000-\u001f\u007f]/.test(s))reject('SOURCE_TREE_PATH','Source inventory requires exact bounded Git entry names',409);
  return s;
}
function treeId(entries:{name:string;mode:SourceTreeEntry['mode'];objectId:string}[]):string{
  const sorted=[...entries].sort((a,b)=>Buffer.compare(Buffer.from(a.name+(a.mode==='040000'?'/':'')),Buffer.from(b.name+(b.mode==='040000'?'/':''))));
  const bytes=Buffer.concat(sorted.flatMap(e=>[Buffer.from((e.mode==='040000'?'40000':e.mode)+' '+e.name+'\0'),Buffer.from(e.objectId,'hex')]));
  return createHash('sha1').update(Buffer.from('tree '+bytes.length+'\0')).update(bytes).digest('hex');
}
/** Complete Git object metadata for one exact commit. Never reads source file
 * contents, dereferences links/submodules, consults HEAD or writes a repository.
 * Reconstructs every Git tree identity; truncated/partial inventories fail. */
export function sourceTreeReader(binding:PlatformRegistration,get:Get){
  return async(actor:Principal,input:{commit:string},signal:AbortSignal):Promise<SourceTreeObservation>=>{
    authorize(actor,binding.projectId,'read');exact(record(input),['commit']);const commit=commitId(input.commit),github=binding.provider==='github';
    const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,30000);signal.addEventListener('abort',abort,{once:true});
    let requests=0,directories=0;const entries:SourceTreeEntry[]=[],paths=new Set<string>();
    async function read(path:string):Promise<unknown>{signal.throwIfAborted();controller.signal.throwIfAborted();if(++requests>MAX_REQUESTS)reject('SOURCE_TREE_LIMIT','Source inventory request limit exceeded',409);return get(actor,path,controller.signal);}
    async function walk(parent:string,expected:string|null,ancestors:Set<string>):Promise<string>{
      if(++directories>MAX_DIRECTORIES||parent.split('/').length>64)reject('SOURCE_TREE_LIMIT','Source directory inventory exceeds its bound',409);
      if(expected&&ancestors.has(expected))reject('SOURCE_TREE_INTEGRITY','Circular Git tree response',409);
      const next=new Set(ancestors);if(expected)next.add(expected);let rows:Record<string,unknown>[]=[];
      if(github){
        const t=record(await read('/git/trees/'+expected));
        if(t.sha!==expected||t.truncated!==false||!Array.isArray(t.tree)||t.tree.length>MAX_DIRECTORY_ENTRIES)reject('SOURCE_TREE_INCOMPLETE','A complete bounded Git tree is required',409);rows=t.tree.map(record);
      }else{
        let complete=false;
        for(let page=1;page<=MAX_DIRECTORY_ENTRIES/100+1;page++){
          const raw=await read('/repository/tree?ref='+commit+'&path='+encodeURIComponent(parent)+'&per_page=100&page='+page);
          if(!Array.isArray(raw)||raw.length>100)reject('SOURCE_TREE_INCOMPLETE','Invalid paginated Git directory',409);
          rows.push(...raw.map(record));if(rows.length>MAX_DIRECTORY_ENTRIES)reject('SOURCE_TREE_LIMIT','Source directory exceeds its entry bound',409);
          if(raw.length<100){complete=true;break;}
        }
        if(!complete)reject('SOURCE_TREE_INCOMPLETE','Source directory did not terminate its pagination',409);
      }
      const children:({name:string}&SourceTreeEntry)[]=[],seen=new Set<string>();
      for(const row of rows){
        const relative=string(row.path,4096),prefix=parent?parent+'/':'';
        if(!github&&!relative.startsWith(prefix))reject('SOURCE_TREE_PATH','Git directory entry belongs to another parent',409);
        const child=name(github?relative:relative.slice(prefix.length)),path=prefix+child,mode=string(row.mode),type=string(row.type);
        if(path.length>4096||seen.has(child)||paths.has(path))reject('SOURCE_TREE_PATH','Duplicate or oversized source path',409);
        if(!['040000','100644','100755','120000','160000'].includes(mode)||type!==(mode==='040000'?'tree':mode==='160000'?'commit':'blob'))reject('SOURCE_TREE_TYPE','Unsupported or inconsistent Git object type',409);
        const entry={path,mode:mode as SourceTreeEntry['mode'],type:type as SourceTreeEntry['type'],objectId:commitId(row[github?'sha':'id'])};
        if(entries.length>=MAX_ENTRIES)reject('SOURCE_TREE_LIMIT','Complete source inventory exceeds its entry bound',409);
        seen.add(child);paths.add(path);entries.push(entry);children.push({name:child,...entry});
      }
      const actual=treeId(children);if(expected&&actual!==expected)reject('SOURCE_TREE_INTEGRITY','Git tree inventory differs from its immutable object identity',409);
      for(const e of children)if(e.type==='tree')await walk(e.path,e.objectId,next);
      return actual;
    }
    try{
      matchRepository(await read(''),binding);
      const c=record(await read((github?'/git/commits/':'/repository/commits/')+commit));
      if(c[github?'sha':'id']!==commit)reject('SOURCE_TREE_COMMIT','Exact source commit is unavailable',409);
      const rootTreeId=await walk('',github?commitId(record(c.tree).sha):null,new Set());
      // GitLab's public commit API omits tree_id; its complete tree is selected
      // by exact commit and each nested tree is independently reconstructed.
      entries.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
      const inventoryDigest=valueDigest(entries),treeDigest=valueDigest({schema:'runtime-git-tree-identity/v1',rootTreeId,inventoryDigest});
      signal.throwIfAborted();controller.signal.throwIfAborted();const facts={provider:binding.provider,projectId:binding.projectId,repositoryId:binding.repositoryId,bindingDigest:valueDigest(binding),commit,rootTreeId,entries,inventoryDigest,treeDigest};
      return{schema:'runtime-source-tree/v1',...facts,factsDigest:valueDigest(facts),observedAt:new Date().toISOString(),contentRead:false,linksFollowed:false,sourceApproved:false};
    }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
  };
}
