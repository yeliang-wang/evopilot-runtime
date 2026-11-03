#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {hostHeaders,readHostConnection} from '../server/security.js';
import {ServiceError} from '../server/errors.js';

/** Private machine-to-machine stdout for Codex's HTTP headers helper. Never
 * invoke this as a human-readable diagnostic or log its successful output. */
export function headersMain(argv:string[],output:Pick<NodeJS.WriteStream,'write'>=process.stdout,errorOutput:Pick<NodeJS.WriteStream,'write'>=process.stderr):number{
  try{if(argv.length!==2||argv[0]!=='--connection-ref')throw new ServiceError('INVALID_ARGUMENT','Expected the protected connection reference');output.write(JSON.stringify(hostHeaders(readHostConnection(argv[1])))+'\n');return 0;}
  catch(error){errorOutput.write(JSON.stringify({error:{code:error instanceof ServiceError?error.code:'CREDENTIAL_UNAVAILABLE',message:'Runtime HTTP credential helper could not supply its scoped credential.'}})+'\n');return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=headersMain(process.argv.slice(2));
