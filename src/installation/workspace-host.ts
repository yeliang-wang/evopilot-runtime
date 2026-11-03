#!/usr/bin/env node
/** Explicit local operator bootstrap, separate from the HTTP service and its
 * transport-only bridge. Loading a plugin never supplies an operator grant. */
import {pathToFileURL} from 'node:url';
import {bridgeMain} from '../host/bridge.js';
import {readWorkspaceOperatorConfiguration} from '../host/workspace.js';
import {ServiceError} from '../server/errors.js';
import {openWorkspaceOperator} from './workspace/operator.js';

export async function workspaceHostMain(argv:string[]):Promise<void>{
  const rest:string[]=[],options=new Map<string,string>();
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];if(!['--operator-config-ref','--operator-config-digest'].includes(arg)){rest.push(arg);continue;}
    if(options.has(arg)||!argv[i+1]||argv[i+1].startsWith('--'))throw new ServiceError('INVALID_ARGUMENT','Select an exact protected local operator configuration');options.set(arg,argv[++i]);
  }
  if(options.size!==2)throw new ServiceError('INVALID_ARGUMENT','Both operator configuration reference and digest are required');
  const selected=readWorkspaceOperatorConfiguration(options.get('--operator-config-ref')!);
  const connection=rest.indexOf('--connection-ref');if(connection>=0&&rest[connection+1]!==selected.connectionRef)throw new ServiceError('WORKSPACE_OPERATOR_SCOPE','Transport and local operator must select the same installation');
  const operator=openWorkspaceOperator(options.get('--operator-config-ref')!,options.get('--operator-config-digest')!);
  await bridgeMain(rest,operator);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await workspaceHostMain(process.argv.slice(2));}catch(error){const code=error instanceof ServiceError?error.code:'WORKSPACE_HOST_START_FAILED';process.stderr.write('Runtime Workspace Host could not start ('+code+'). Inspect its protected local selection.\n');process.exitCode=1;}}
