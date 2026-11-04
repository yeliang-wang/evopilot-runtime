import {constants,openSync,closeSync,writeFileSync,fsyncSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {inspectCodexSource,inspectCodexCursor,validateUsageGrant} from '../usage/codex.js';
import {canonical,digest,exact,record,reject} from '../server/errors.js';
import {ensurePrivateRoot,readPrivateJson,currentPrincipal,authorize} from '../server/security.js';
import {createRuntimeHttpClient} from './client.js';

/** Installed CLI/Expert report helper; all reads go through the same scoped
 * service. This entry has no local database or model-provider fallback. */
export async function readHostUsage(connectionRef:string,queryRef:string,format:'json'|'markdown'){
  if(!['json','markdown'].includes(format))reject('USAGE_FORMAT','Choose json or markdown');
  const query=record(readPrivateJson(queryRef));exact(query,['targetVersion'],['instanceId','stageId','throughTime']);
  const client=createRuntimeHttpClient(connectionRef);
  return client.request({operation:'usage.report.read',projectId:client.connection.projectId,input:{...query,format}});
}

/** Local operator entry only. Remote clients can select the resulting opaque
 * id, never a pathname or arbitrary log. Existing grants are immutable. */
export function installUsageGrant(stateRoot:string,workspaceId:string,inputRef:string):{id:string;grantDigest:string;readOnly:true}{
  const value=validateUsageGrant(readPrivateJson(inputRef));if(value.workspaceId!==workspaceId)reject('USAGE_SCOPE','Grant belongs to another workspace');
  const actor=currentPrincipal(stateRoot,workspaceId,value.principalId);if(!actor||actor.revision!==value.principalRevision)reject('USAGE_SCOPE','Grant requires the current exact principal',403);authorize(actor,value.projectId,'draft.write');
  if(Date.parse(value.expiresAt)<=Date.now())reject('USAGE_EXPIRED','Grant expired',403);
  if(digest(inspectCodexSource(value.path))!==digest(value.identity))reject('USAGE_SOURCE_CHANGED','Select the original inspected Codex source');
  if(value.initialCursor&&digest(inspectCodexCursor(value.path,value.initialCursor.offset))!==digest(value.initialCursor))reject('USAGE_SOURCE_CHANGED','Original epoch boundary changed');
  const root=join(stateRoot,'usage-grants');ensurePrivateRoot(root);const path=join(root,value.id+'.json');
  if(existsSync(path)){if(digest(validateUsageGrant(readPrivateJson(path)))!==digest(value))reject('USAGE_GRANT_CONFLICT','Existing source grant cannot be overwritten',409);}
  else{const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,canonical(value));fsyncSync(fd);}finally{closeSync(fd);}}
  return{id:value.id,grantDigest:digest(value),readOnly:true};
}
