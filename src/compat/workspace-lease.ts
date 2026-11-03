/** Shared operation/maintenance exclusion, compatible with the original
 * workspace coordination identity. A lease grants no business authority. */
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {canonicalJSON,canonicalPath,codeRoot,fail} from './project/files.js';

export interface WorkspaceLeaseContext {workspaceRoot:string;workspaceId:string;}
function present(filename:string):boolean {
  try{fs.lstatSync(filename);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
function safe(filename:string,directory:boolean):void {
  canonicalPath(filename);const st=fs.lstatSync(filename);
  if(st.uid!==process.getuid!()||(st.mode&0o777)!==(directory?0o700:0o600)||(directory?!st.isDirectory():!st.isFile()||st.nlink!==1||st.size>1048576))fail('UNSAFE_COORDINATION');
}
function check(root:string):void {
  safe(root,true);
  for(const name of fs.readdirSync(root)){
    if(!['lease.db','lease.db-journal'].includes(name))fail('UNSAFE_COORDINATION');
    try{safe(path.join(root,name),false);}catch(error){if(name!=='lease.db-journal'||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
}
function location(context:WorkspaceLeaseContext):string {
  if(!context||Object.keys(context).sort().join('|')!=='workspaceId|workspaceRoot'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(context.workspaceId))fail('WORKSPACE_IDENTITY');
  const root=canonicalPath(context.workspaceRoot,true);
  if(root===path.parse(root).root||root===codeRoot||root.startsWith(codeRoot+path.sep)||codeRoot.startsWith(root+path.sep))fail('WORKSPACE_LOCATION');
  for(let p=root;;p=path.dirname(p)){if(present(path.join(p,'.git')))fail('WORKSPACE_IN_GIT');if(p===path.dirname(p))break;}
  if(present(root))safe(root,true);
  return root+'.evopilot-coordination';
}
/** Shared by Host work and operator maintenance, never held by Runtime's
 * lifetime writer. Process death releases the SQLite transaction. A pending
 * business request remains pending regardless of lease availability. */
export async function withWorkspaceLease<T>(context:WorkspaceLeaseContext,requestId:string,callback:()=>Promise<T>|T,signal?:AbortSignal):Promise<T> {
  if(typeof requestId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(requestId))fail('INVALID_REQUEST');
  signal?.throwIfAborted();const root=location(context);canonicalPath(root,true);
  try{fs.mkdirSync(root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  check(root);const filename=path.join(root,'lease.db');
  if(!present(filename)){try{fs.closeSync(fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
  safe(filename,false);const db=new DatabaseSync(filename,{timeout:0,allowExtension:false});db.enableDefensive(true);let held=false;
  const deadline=Date.now()+10000;
  try{
    while(!held){
      signal?.throwIfAborted();check(root);
      try{db.exec('BEGIN IMMEDIATE');held=true;}
      catch(error){if(!error||typeof error!=='object'||!('errcode' in error)||![5,6].includes(Number(error.errcode)))throw error;if(Date.now()>=deadline)fail('WORKSPACE_BUSY');await new Promise(resolve=>setTimeout(resolve,40));}
    }
    db.exec('CREATE TABLE IF NOT EXISTS workspace_lease (id INTEGER PRIMARY KEY CHECK(id=1), workspace TEXT NOT NULL, owner TEXT NOT NULL)');
    const workspace=canonicalJSON({schema:'evopilot-workspace/v1',id:context.workspaceId,canonicalRoot:context.workspaceRoot,ownerUid:process.getuid!()});
    const previous=db.prepare('SELECT workspace FROM workspace_lease WHERE id=1').get();
    if(previous&&previous.workspace!==workspace)fail('IDENTITY_CONFLICT');
    db.prepare('INSERT INTO workspace_lease (id,workspace,owner) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner').run(workspace,canonicalJSON({installation:{product:'evopilot-runtime',entry:'scoped-operation-or-maintenance'},requestId,pid:process.pid}));
    signal?.throwIfAborted();const result=await callback();
    db.prepare('UPDATE workspace_lease SET owner=? WHERE id=1').run('null');db.exec('COMMIT');held=false;return result;
  }finally{if(held){try{db.exec('ROLLBACK');}catch{}}db.close();check(root);}
}
