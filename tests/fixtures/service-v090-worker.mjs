import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../../dist/server/store.js';
import { startRuntimeServer } from '../../dist/server/http.js';
import { registeredAuthorityPolicy } from '../../dist/adapters/authority.js';
import { valueDigest } from '../../dist/lifecycle/base.js';
import { syntheticBindings } from './lifecycle-v090.mjs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [mode, root, workspaceId] = process.argv.slice(2);
if(mode.startsWith('execution-crash-')){
  const bindings=syntheticBindings(),adapterDigest=valueDigest('synthetic-stage-adapter-v1');
  const adapter={
    async prepare(_instance,stageId){return{adapterId:'synthetic-stage-adapter',adapterDigest,action:'base.'+stageId,bindingDigest:valueDigest('synthetic-binding'),parameters:{synthetic:true}};},
    async dispatch(request,_instance,permit){
      await permit();
      if(mode==='execution-crash-after-dispatch')writeFileSync(join(root,'synthetic-provider-request.json'),JSON.stringify({requestId:request.id,inputDigest:request.inputDigest}),{mode:0o600});
      process.kill(process.pid,'SIGKILL');return new Promise(()=>{});
    },
    async inspect(){throw new Error('A crashed process cannot synthesize provider completion');},
  };
  const server=await startRuntimeServer({stateRoot:root,workspaceId},bindings.provider,undefined,registeredAuthorityPolicy(join(dirname(root),'integrations.json'),workspaceId),adapter);
  process.stdout.write(JSON.stringify({ready:true,url:server.url})+'\n');
  await new Promise(()=>{});
}else{
const store = new RuntimeStore(root,workspaceId);
const actor = {id:'fixture',projects:['alpha'],permissions:['read','draft.write'],revision:1,expiresAt:'2030-01-01T00:00:00Z'};
if (mode.startsWith('crash-')) {
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if(sql==='COMMIT;' && mode==='crash-before-commit')process.kill(process.pid,'SIGKILL');
    const result = original.call(this,sql);
    if(sql==='COMMIT;' && mode==='crash-after-commit')process.kill(process.pid,'SIGKILL');
    return result;
  };
}
store.mutate(actor,{projectId:'alpha',operation:'fixture.write',requestId:'worker-write',expectedRevision:0,input:{value:1},permission:'draft.write'},()=>({value:{ok:true},objects:[{kind:'fixture',id:'one',value:{synthetic:true}}],event:{type:'fixture-written',data:{synthetic:true}}}));
if(mode==='hold') {
  // A live process alone does not retain DatabaseSync handles. Keep the store
  // reachable for the whole holding phase, as the actual service does.
  setInterval(()=>store.revision('alpha'),1000);
  setImmediate(()=>{
    global.gc?.();
    process.stdout.write(JSON.stringify({ready:true,gcTested:typeof global.gc==='function'})+'\n');
  });
} else store.close();

}
