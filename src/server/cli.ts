#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { constants, closeSync, fsyncSync, openSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, exact, record, reject, ServiceError, slug, string } from './errors.js';
import { ensurePrivateRoot, initializeCredentials, readPrivateJson, tokenDigest,readHostConnection,hostHeaders, type Permission } from './security.js';
import {createRuntimeHttpClient} from '../host/client.js';
import { startRuntimeServer } from './http.js';
import { openRegisteredBindings } from '../adapters/bindings.js';
import { registeredAuthorityPolicy } from '../adapters/authority.js';
import type {LegacyIntentSource} from '../compat/gateway.js';
import {openRegisteredLegacyProviders} from '../compat/registered-providers.js';

export async function serviceMain(argv: string[], output: { write(value: string): unknown } = process.stdout): Promise<number> {
  const print=(v:unknown)=>output.write(canonical(v)+'\n');
  try {
    const [command,...args]=argv, flags: Record<string,string>=Object.create(null);
    for(let i=0;i<args.length;i+=2){const name=args[i];if(!/^--[a-z-]+$/.test(name)||!args[i+1]||args[i+1].startsWith('--')||Object.hasOwn(flags,name.slice(2)))reject('INVALID_ARGUMENT','Expected unique named arguments');flags[name.slice(2)]=args[i+1];}
    if(command==='help' || !command){exact(flags,[]);print({commands:['auth-init','serve','status','request','browser-code'],developmentTarget:'0.9.0',releaseReady:false,credentials:'Use protected credential files; do not pass raw tokens on the command line.',request:'request --url <origin> --token-ref <protected file> --project <id> --request-ref <protected JSON envelope>; no automatic retry after uncertain transport results.',browser:'browser-code --connection-ref <protected connection>; enter the one-use code on /monitor or /lifecycle. No token in the URL.'});return 0;}
    if(command==='browser-code'){
      exact(flags,['connection-ref']);const connection=readHostConnection(flags['connection-ref']);await createRuntimeHttpClient(flags['connection-ref']).status();
      const response=await fetch(connection.origin+'/api/v1/dashboard-code',{method:'POST',headers:{...hostHeaders(connection),'content-type':'application/json'},body:canonical({projectId:connection.projectId}),signal:AbortSignal.timeout(10000),redirect:'error'});
      if(!response.headers.get('content-type')?.startsWith('application/json')||!response.body)reject('INVALID_SERVICE_RESPONSE','Expected a bounded browser connection response',502);
      const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>4096)reject('SERVICE_RESPONSE_LIMIT','Browser connection response exceeds its limit',502);parts.push(part.value);}}catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
      const value=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts))) as unknown);if(!response.ok){const error=record(value.error);reject(string(error.code),string(error.message),response.status);}const result=record(value.result);exact(result,['code','expiresAt','projectId']);
      if(!/^[A-Za-z0-9_-]{43}$/.test(string(result.code,128))||!Number.isFinite(Date.parse(string(result.expiresAt,64))))reject('INVALID_SERVICE_RESPONSE','Invalid browser connection response',502);
      if(result.projectId!==connection.projectId)reject('WRONG_WORKSPACE','Browser code does not match the selected project');
      print({url:connection.origin+'/monitor',...result,oneUse:true,executionAuthorized:false});return 0;
    }
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
      exact(flags,['state-root','workspace-id'],['port','integrations-ref','legacy-ref','legacy-providers-ref']);
      if(flags['legacy-providers-ref']&&!flags['legacy-ref'])reject('LEGACY_PROVIDER_SCOPE','Original providers require an exact service migration binding');
      let legacyIntentSource:LegacyIntentSource|undefined;
      const managedIntent=flags['legacy-ref']?()=>{if(!legacyIntentSource)reject('RUNTIME_INTENT_STORE_MISSING','The managed Runtime intent source is not ready');return legacyIntentSource;}:undefined;
      const integrations=flags['integrations-ref']?await openRegisteredBindings(flags['integrations-ref'],flags['workspace-id'],managedIntent):undefined;
      let legacyProviders:Awaited<ReturnType<typeof openRegisteredLegacyProviders>>|undefined;
      try{
        if(flags['legacy-providers-ref'])legacyProviders=await openRegisteredLegacyProviders(flags['legacy-providers-ref'],flags['legacy-ref'],flags['workspace-id']);
        const policy=flags['integrations-ref']?registeredAuthorityPolicy(flags['integrations-ref'],flags['workspace-id']):undefined;
        const server=await startRuntimeServer({stateRoot:flags['state-root'],workspaceId:flags['workspace-id'],port:flags.port===undefined?0:Number(flags.port),...(flags['legacy-ref']?{legacyBindingRef:flags['legacy-ref']}:{})},integrations?.provider,undefined,policy,integrations?.executor,integrations?.preparation,integrations?.implementationReview,integrations?.extensionReview,legacyProviders?.bind);
        legacyIntentSource=server.legacyIntentSource;
        print({ready:true,url:server.url,...server.identity});
        await new Promise<void>(resolve=>{
          const stop=()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);void server.close().then(resolve);};
          process.once('SIGINT',stop);process.once('SIGTERM',stop);
        });return 0;
      }finally{legacyProviders?.close();integrations?.close();}
    }
    if(command==='status'||command==='request'){
      exact(flags,command==='status'?['url','token-ref','project']:['url','token-ref','project','request-ref']);
      const url=new URL(flags.url);
      if(url.protocol!=='http:' || !['127.0.0.1','localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname!=='/')reject('INVALID_URL','Use the exact local Runtime HTTP origin');
      const credential=record(readPrivateJson(flags['token-ref']));exact(credential,['schema','workspaceId','principalId','projectId','token']);
      if(credential.schema!=='runtime-client-credential/v1' || credential.projectId!==flags.project)reject('CREDENTIAL_SCOPE','Credential belongs to a different project');
      const token=string(credential.token);
      const response=await fetch(new URL('/api/v1/status?projectId='+encodeURIComponent(slug(flags.project)),url),{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(10000),redirect:'error'});
      const value=record(await response.json());
      if(response.ok && record(value.result).workspaceId!==credential.workspaceId)reject('WRONG_WORKSPACE','Runtime identity differs from the selected credential');
      if(command==='status'||!response.ok){print(value);return response.ok?0:1;}
      const envelope=record(readPrivateJson(flags['request-ref']));
      exact(envelope,['operation','projectId','input'],['requestId','expectedRevision']);
      if(envelope.projectId!==flags.project)reject('CREDENTIAL_SCOPE','Request belongs to a different project');
      const operation=string(envelope.operation);record(envelope.input);
      // No source/store bypass: all request validation, CAS, roles and admission
      // remain in the same HTTP dispatcher used by MCP and the Dashboard.
      try{
        const result=await fetch(new URL('/api/v1/request',url),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:canonical(envelope),signal:AbortSignal.timeout(15000),redirect:'error'});
        print(await result.json());return result.ok?0:1;
      }catch{
        print({error:{code:'REQUEST_OUTCOME_UNKNOWN',message:'Inspect the original request receipt before any further mutation.'},operation,requestId:envelope.requestId??null,automaticRetry:false});return 1;
      }
    }
    reject('UNKNOWN_COMMAND','Unsupported Runtime service command');
  }catch(e){const error=e instanceof ServiceError?e:e&&typeof e==='object'&&'code'in e&&e.code==='EADDRINUSE'?new ServiceError('PORT_IN_USE','The selected Runtime port is already in use',409):new ServiceError('OPERATION_FAILED','Local service operation failed',500);print({error:{code:error.code,message:error.message}});return 1;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await serviceMain(process.argv.slice(2));
