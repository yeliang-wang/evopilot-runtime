#!/usr/bin/env node
/** Explicit installed first-use operator, sharing the existing stdio entry of
 * the same HTTP-primary plugin. No startup occurs merely by loading this file. */
import {pathToFileURL} from 'node:url';
import {bridgeMain} from '../host/bridge.js';
import {readWorkspaceSetupConfiguration} from '../host/setup.js';
import {ServiceError} from '../server/errors.js';
import {openWorkspaceSetupOperator} from './workspace/setup-operator.js';
export async function setupHostMain(argv:string[]):Promise<void>{
  const rest:string[]=[],options=new Map<string,string>();
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];if(!['--setup-config-ref','--setup-config-digest'].includes(arg)){rest.push(arg);continue;}
    if(options.has(arg)||!argv[i+1]||argv[i+1].startsWith('--'))throw new ServiceError('INVALID_ARGUMENT','Choose one exact protected first-use configuration');options.set(arg,argv[++i]);
  }
  if(options.size!==2||rest.includes('--owner-config-ref')||rest.includes('--owner-config-digest'))throw new ServiceError('INVALID_ARGUMENT','First-use configuration owns the exact owner route selection');
  const ref=options.get('--setup-config-ref')!,c=readWorkspaceSetupConfiguration(ref),connection=rest.indexOf('--connection-ref');
  if(connection<0||rest[connection+1]!==c.connectionRef)throw new ServiceError('WORKSPACE_OPERATOR_SCOPE','Setup and transport must use the same installation');
  const operator=openWorkspaceSetupOperator(ref,options.get('--setup-config-digest')!);
  await bridgeMain(rest,operator,operator.connectionSelection);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await setupHostMain(process.argv.slice(2));}catch(error){const code=error instanceof ServiceError?error.code:'SETUP_HOST_FAILED';process.stderr.write('Runtime first-use Host could not start ('+code+'). Inspect its protected selection.\n');process.exitCode=1;}}
