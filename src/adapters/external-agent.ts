import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { byteDigest } from '../lifecycle/base.js';
import { exact, record, reject, string } from '../server/errors.js';

const execute=promisify(execFile);
export interface AgentIdentity { adapter:'codex';version:string;executableDigest:string;hostId:string;modelInvoked:false; }
/** A fixed version query establishes identity only. Runtime receives no model
 * profile/key, starts no coding task and cannot take authority from CLI output. */
export async function inspectExternalAgent(definition:Record<string,unknown>,signal:AbortSignal):Promise<AgentIdentity>{
  exact(definition,['kind','adapter','executable','version','hostId','workspaceRoot']);
  if(definition.kind!=='agent'||definition.adapter!=='codex')reject('UNSUPPORTED_AGENT','Only the registered external Codex adapter is available');
  const file=record(definition.executable);exact(file,['path','digest']);const path=string(file.path,4096),expected=string(file.digest,71),version=string(definition.version,128),hostId=string(definition.hostId,256);
  function verify(){
    if(!isAbsolute(path)||realpathSync(path)!==path)reject('AGENT_IDENTITY_CHANGED','Agent executable must be canonical');
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o022)!==0||(stat.mode&0o111)===0||stat.size<1||stat.size>268435456||byteDigest(readFileSync(fd))!==expected)reject('AGENT_IDENTITY_CHANGED','Agent executable differs from its registered bytes');}finally{closeSync(fd);}
  }
  signal.throwIfAborted();verify();let stdout:string;
  try{({stdout}=await execute(path,['--version'],{encoding:'utf8',timeout:3000,maxBuffer:8192,signal,windowsHide:true}));}
  catch{return reject('AGENT_UNAVAILABLE','Registered Codex version query did not complete',409);}
  if(stdout.trim()!=='codex-cli '+version)reject('AGENT_IDENTITY_CHANGED','External Agent does not report the exact configured Codex version',409);
  signal.throwIfAborted();verify();return{adapter:'codex',version,executableDigest:expected,hostId,modelInvoked:false};
}
