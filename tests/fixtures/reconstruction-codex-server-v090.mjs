// Synthetic protocol peer only. No credentials, model calls, or real-project acceptance.
import readline from 'node:readline';
import {CODEX_FIXED_CONFIG} from '../../dist/compat/reconstruction/codex-reconstruction.js';
export function serve(mode,policyPath){
 if(process.argv.includes('--version')){process.stdout.write('codex-cli 0.163.0-alpha.10.2\n');return;}
 const config={};for(const [key,value] of Object.entries(CODEX_FIXED_CONFIG)){const names=key.split('.');let o=config;for(const name of names.slice(0,-1))o=o[name]??={};o[names.at(-1)]=value;}
 const send=m=>process.stdout.write(JSON.stringify(m)+'\n'),event=(method,params)=>send({method,params}),threadId='synthetic-thread',turnId='synthetic-turn';
 readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.id===undefined)return;
  const reply=result=>send({id:m.id,result});
  if(m.method==='initialize')reply({});
  else if(m.method==='config/read'){if(mode==='config-drift')config.features.shell_tool=true;config.permissions.evopilot_generate.description=null;config.permissions.evopilot_generate.filesystem.glob_scan_max_depth=null;if(mode==='permission-drift')config.permissions.evopilot_generate.filesystem['/']='write';reply({config});}
  else if(m.method==='thread/start')reply({thread:{id:threadId},model:'gpt-synthetic',modelProvider:'openai',approvalPolicy:'never',activePermissionProfile:{id:'evopilot_generate'},runtimeWorkspaceRoots:[],instructionSources:mode==='context-drift'?['/unreviewed/AGENTS.md']:[policyPath]});
  else if(m.method==='mcpServerStatus/list')reply({data:[],nextCursor:null});
  else if(m.method==='turn/start'){
   if(mode==='seeded'&&/mountPoint|\"seeds\"/.test(m.params.input[0].text)){send({id:m.id,error:{code:-32602,message:'Hidden input metadata leaked to generator'}});return;}
   reply({turn:{id:turnId}});event('turn/started',{threadId,turn:{id:turnId}});
   if(mode==='hang')return;
   if(mode==='tool'){event('item/started',{threadId,turnId,item:{id:'tool',type:'commandExecution'}});return;}
   if(mode==='stream'){process.stdout.write('x'.repeat(100000));return;}
   if(mode!=='missing-usage')event('thread/tokenUsage/updated',{threadId,turnId,tokenUsage:{total:{totalTokens:mode==='tokens'?1000001:123}}});
   const files=[{path:mode==='path'?'../escape.mjs':'app.mjs',content:['state','seeded'].includes(mode)?'import {DatabaseSync} from "node:sqlite"; export const transform = value => value + 3; export function open(root){const db=new DatabaseSync(root+"/state.db");return {initialize(){db.exec("CREATE TABLE counter (n INTEGER); INSERT INTO counter VALUES (1)");},value(){return db.prepare("SELECT n FROM counter").get().n;},advance(){db.exec("UPDATE counter SET n=n+1");},close(){db.close();}};}':'export const transform = value => value + 3;' }];
   event('item/completed',{threadId,turnId,item:{id:'answer',type:'agentMessage',phase:'final_answer',text:JSON.stringify({files})}});
   event('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});
  }else send({id:m.id,error:{code:-32601,message:'Unsupported synthetic request'}});
 });
}
