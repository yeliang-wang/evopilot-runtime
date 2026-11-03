import {createRuntimeService,type Providers,type SyncOperation,type Request,type ReconstructionRequest,type ReconstructionResults} from '../service.js';
import {reject} from '../server/errors.js';
import {acquireManagedLegacyContext,type ManagedLegacyBinding} from './managed-store.js';

/** Reuse Runtime-owned legacy semantics without translating any original
 * revision, request, Run, claim, budget, decision or receipt. Transport admission
 * is separate: this internal owner gateway grants no HTTP/Host authority. */
export function createManagedLegacyService(binding:ManagedLegacyBinding,providers:Providers={},authorize?:()=>void) {
  const context=acquireManagedLegacyContext(binding,authorize);
  let service:ReturnType<typeof createRuntimeService>;
  try {service=context.run(()=>createRuntimeService({workspaceRoot:binding.workspaceRoot,workspaceId:binding.workspaceId},providers));context.run(()=>service.initialize());}
  catch(error){context.close();throw error;}
  let inFlight=0,closed=false;
  async function asyncCall<T>(fn:()=>Promise<T>):Promise<T>{inFlight++;try{return await context.run(fn);}finally{inFlight--;}}
  return Object.freeze({
    capabilities:()=>context.run(()=>service.capabilities()),
    initialize:()=>context.run(()=>service.initialize()),
    execute:<K extends SyncOperation>(request:Request<K>)=>context.run(()=>service.execute(request)),
    native:(request:Parameters<typeof service.native>[0])=>asyncCall(()=>service.native(request)),
    readable:(request:Parameters<typeof service.readable>[0])=>asyncCall(()=>service.readable(request)),
    feedback:(request:Parameters<typeof service.feedback>[0])=>asyncCall(()=>service.feedback(request)),
    online:(request:Parameters<typeof service.online>[0])=>asyncCall(()=>service.online(request)),
    response:(request:Parameters<typeof service.response>[0])=>asyncCall(()=>service.response(request)),
    planning:(request:Parameters<typeof service.planning>[0])=>asyncCall(()=>service.planning(request)),
    readiness:(request:Parameters<typeof service.readiness>[0])=>asyncCall(()=>service.readiness(request)),
    reconstruction:<K extends keyof ReconstructionResults>(request:ReconstructionRequest<K>)=>asyncCall(()=>service.reconstruction(request)),
    dispatch:(request:Parameters<typeof service.dispatch>[0])=>asyncCall(()=>service.dispatch(request)),
    reconcile:(request:Parameters<typeof service.reconcile>[0])=>asyncCall(()=>service.reconcile(request)),
    close(){if(closed)return;if(inFlight)reject('BUSY','Retain the managed writer until original operations settle',409);context.run(()=>service.close());context.close();closed=true;}
  });
}
