import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../../dist/server/store.js';
const [mode, root, workspaceId] = process.argv.slice(2);
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
  process.stdout.write(JSON.stringify({ready:true})+'\n');
  setInterval(()=>{},1000);
} else store.close();
