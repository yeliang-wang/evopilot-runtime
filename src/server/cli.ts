#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { constants, closeSync, fsyncSync, openSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, exact, record, reject, ServiceError, slug, string } from './errors.js';
import { ensurePrivateRoot, initializeCredentials, readPrivateJson, tokenDigest, type Permission } from './security.js';
import { startRuntimeServer } from './http.js';

export async function serviceMain(argv: string[], output: { write(value: string): unknown } = process.stdout): Promise<number> {
  const print=(v:unknown)=>output.write(canonical(v)+'\n');
  try {
    const [command,...args]=argv, flags: Record<string,string>=Object.create(null);
    for(let i=0;i<args.length;i+=2){const name=args[i];if(!/^--[a-z-]+$/.test(name)||!args[i+1]||args[i+1].startsWith('--')||Object.hasOwn(flags,name.slice(2)))reject('INVALID_ARGUMENT','Expected unique named arguments');flags[name.slice(2)]=args[i+1];}
    if(command==='help' || !command){exact(flags,[]);print({commands:['auth-init','serve','status'],developmentTarget:'0.9.0',releaseReady:false,credentials:'Use protected credential files; do not pass raw tokens on the command line.'});return 0;}
    if(command==='auth-init'){
      exact(flags,['state-root','workspace-id','project','principal','role']);
      const root=flags['state-root'],workspaceId=slug(flags['workspace-id']),projectId=slug(flags.project),id=slug(flags.principal);
      const roles:Record<string,Permission[]>={reader:['read'],editor:['read','draft.write'],activator:['read','draft.write','definition.activate']};
      if(!Object.hasOwn(roles,flags.role))reject('INVALID_ROLE','Choose reader, editor or activator');
      ensurePrivateRoot(root);const token=randomBytes(32).toString('base64url'),tokenRef=join(root,'principal-'+id+'.json');
      const fd=openSync(tokenRef,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      try{writeFileSync(fd,canonical({schema:'runtime-client-credential/v1',workspaceId,principalId:id,projectId,token}));fsyncSync(fd);}finally{closeSync(fd);}
      try{initializeCredentials(root,workspaceId,[{id,projects:[projectId],permissions:roles[flags.role],revision:1,expiresAt:new Date(Date.now()+30*86400000).toISOString(),tokenDigest:tokenDigest(token)}]);}
      catch(e){unlinkSync(tokenRef);throw e;}
      print({initialized:true,workspaceId,projectId,principalId:id,role:flags.role,tokenRef,executionAuthorized:false,releaseAuthorized:false});return 0;
    }
    if(command==='serve'){
      exact(flags,['state-root','workspace-id'],['port']);
      const server=await startRuntimeServer({stateRoot:flags['state-root'],workspaceId:flags['workspace-id'],port:flags.port===undefined?0:Number(flags.port)});
      print({ready:true,url:server.url,...server.identity});
      await new Promise<void>(resolve=>{
        const stop=()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);void server.close().then(resolve);};
        process.once('SIGINT',stop);process.once('SIGTERM',stop);
      });return 0;
    }
    if(command==='status'){
      exact(flags,['url','token-ref','project']);
      const url=new URL(flags.url);
      if(url.protocol!=='http:' || !['127.0.0.1','localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname!=='/')reject('INVALID_URL','Use the exact local Runtime HTTP origin');
      const credential=record(readPrivateJson(flags['token-ref']));exact(credential,['schema','workspaceId','principalId','projectId','token']);
      if(credential.schema!=='runtime-client-credential/v1' || credential.projectId!==flags.project)reject('CREDENTIAL_SCOPE','Credential belongs to a different project');
      const token=string(credential.token);
      const response=await fetch(new URL('/api/v1/status?projectId='+encodeURIComponent(slug(flags.project)),url),{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(10000),redirect:'error'});
      const value=record(await response.json());
      if(response.ok && record(value.result).workspaceId!==credential.workspaceId)reject('WRONG_WORKSPACE','Runtime identity differs from the selected credential');
      print(value);return response.ok?0:1;
    }
    reject('UNKNOWN_COMMAND','Unsupported Runtime service command');
  }catch(e){const error=e instanceof ServiceError?e:new ServiceError('OPERATION_FAILED','Local service operation failed',500);print({error:{code:error.code,message:error.message}});return 1;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await serviceMain(process.argv.slice(2));
