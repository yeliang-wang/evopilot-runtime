import path from 'node:path';
import {exact,record,reject,string} from '../../server/errors.js';
import {createNativeProjectService,type NativeProjectContext,type NativeProjectTrusted} from '../../compat/project/native-project.js';
import {projectOperation} from '../../compat/project/ledger.js';
import {validateCampaignDocument} from '../../compat/project/campaign.js';
import {readRegular,codeRoot} from '../../compat/project/files.js';
import {nativeBytesDigest,nativeSha256,nativeRelativePath,type NativeScope} from '../../../vendor/compatibility/v1/native.mjs';
import {responseReference,type ResponseEvidenceRef,type ResponseEvidence} from '../../../vendor/compatibility/response/v1/response.mjs';

export const PROJECT_NATIVE_METHODS={preflight:'preflight',prepare:'prepare',freeze:'freeze',materialize:'materialize','review-domain':'reviewDomain',inspect:'inspect','check-layout':'checkLayout','candidate-location':'candidateLocation','prepare-execution':'prepareExecution',promote:'promote'} as const;
export const PROJECT_LEDGER_OPERATIONS=['bind','inspect','drift','baseline.accept','campaign.write','campaign.inspect'] as const;
export const PROJECT_CALLS=[...Object.keys(PROJECT_NATIVE_METHODS).map(v=>'native:'+v),...PROJECT_LEDGER_OPERATIONS.map(v=>'workspace:'+v)];
export interface ProjectHostSelection {root:string;calls:string[];}
export interface ProjectHostRoutes {
  native(operation:string,input:unknown):Promise<unknown>;
  workspace(operation:string,input:unknown,requestId:string):Promise<unknown>;
  providers:Pick<ReturnType<typeof createNativeProjectService>,'resolveNativeAuthoring'|'resolveReadinessAuthoring'>;
  readWorkspaceEvidence(request:{scope:NativeScope;reference:ResponseEvidenceRef}):ResponseEvidence;
}
export function createProjectHostRoutes(context:NativeProjectContext,projectId:string,selection:ProjectHostSelection,trusted:NativeProjectTrusted,guard:()=>void):ProjectHostRoutes {
  const current=()=>{guard();trusted.assertCurrent?.();};
  function scoped(value:unknown):void {const scope=record(value);exact(scope,['projectId','visibility']);if(scope.projectId!==projectId||!['public','private'].includes(String(scope.visibility)))reject('OWNER_HOST_SCOPE','Project helper belongs to its registered project',403);current();}
  const project=createNativeProjectService(context,{...trusted,assertCurrent:current});
  function admitted(family:'native'|'workspace',operation:string):void {current();if(!selection.calls.includes(family+':'+operation))reject('OWNER_HOST_CALL_FORBIDDEN','This project helper is not selected by the protected Host configuration',403);}
  return{
    providers:{resolveNativeAuthoring:request=>{scoped(request.scope);return project.resolveNativeAuthoring(request);},resolveReadinessAuthoring:request=>{scoped(request.scope);return project.resolveReadinessAuthoring(request);}},
    async native(operation,value){
      admitted('native',operation);const input=record(value);scoped(operation==='preflight'?record(input.project).scope:input.scope);
      const method=PROJECT_NATIVE_METHODS[operation as keyof typeof PROJECT_NATIVE_METHODS];if(!method)reject('PROJECT_OPERATION','Unknown native project operation');
      const result=await (project[method] as (input:unknown)=>unknown)(input);current();return result;
    },
    async workspace(operation,value,requestId){
      admitted('workspace',operation);const input=record(value);if(input.projectId!==projectId)reject('OWNER_HOST_SCOPE','Project ledger belongs to its registered project',403);
      if(!PROJECT_LEDGER_OPERATIONS.includes(operation as never))reject('PROJECT_OPERATION','Unknown ledger operation');
      const result=await projectOperation({...context,installationRoot:codeRoot,assertCurrent:current},operation as Parameters<typeof projectOperation>[1],input,string(requestId,64));current();return result;
    },
    readWorkspaceEvidence(request){
      current();scoped(request.scope);responseReference(request.reference);if(request.scope.visibility!=='private'||request.reference.owner!=='workspace')reject('RESPONSE_LEDGER_SCOPE','Private project ledger reference required');
      const parts=request.reference.id.split('#loop=');if(parts.length>2||request.reference.id.includes('#')&&parts.length!==2)reject('RESPONSE_LEDGER_REFERENCE','Unsupported ledger reference');
      const relative=parts[0];nativeRelativePath(relative);if(!relative.startsWith('private/projects/'+projectId+'/targets/')||!relative.endsWith('.json'))reject('RESPONSE_LEDGER_SCOPE','Reference is outside this project ledger');
      const marker=record(JSON.parse(readRegular(path.join(context.projectRoot,'workspace-project.json'),1048576,true).toString()));if(marker.schema!=='evopilot-workspace-project/v1'||marker.id!==context.workspaceId)reject('RESPONSE_LEDGER_WORKSPACE','Project workspace identity changed');
      const bytes=readRegular(path.join(context.projectRoot,relative),1048576,true),campaign=record(JSON.parse(bytes.toString()));validateCampaignDocument(campaign);
      if(campaign.projectId!==projectId||relative.split('/').at(-2)!==campaign.id)reject('RESPONSE_LEDGER_REFERENCE','Ledger identity differs from reference');
      const campaignDigest=nativeBytesDigest(bytes);let actualDigest=campaignDigest;
      if(parts.length===2){const matches=campaign.loops.filter(v=>v.id===parts[1]);if(matches.length!==1)reject('RESPONSE_LEDGER_LOOP','Exact retained loop required');actualDigest=nativeSha256({campaignDigest,loop:matches[0]});}
      if(actualDigest!==request.reference.digest)reject('RESPONSE_LEDGER_DRIFT','Ledger bytes differ from original reference');current();
      // The old ledger has no authoritative observation clock. Preserve the
      // structural sentinel; the response contract excludes it as a prerequisite.
      return{workspaceId:context.workspaceId,scope:request.scope,reference:request.reference,status:'PASS',observedAt:1};
    },
  };
}
