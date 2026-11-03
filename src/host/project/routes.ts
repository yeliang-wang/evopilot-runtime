import {exact,record,reject,string} from '../../server/errors.js';
import {createNativeProjectService,type NativeProjectContext,type NativeProjectTrusted} from '../../compat/project/native-project.js';
import {projectOperation} from '../../compat/project/ledger.js';
import {codeRoot} from '../../compat/project/files.js';
import {readWorkspaceResponseEvidence} from '../../compat/response-evidence.js';
import {type NativeScope} from '../../../vendor/compatibility/v1/native.mjs';
import {type ResponseEvidenceRef,type ResponseEvidence} from '../../../vendor/compatibility/response/v1/response.mjs';

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
    readWorkspaceEvidence(request){current();scoped(request.scope);const result=readWorkspaceResponseEvidence(context,request.scope,request.reference);current();return result;},
  };
}
