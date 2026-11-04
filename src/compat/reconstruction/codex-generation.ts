import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import {usabilityStable} from '../../../vendor/usability/v1/contract.mjs';
import {nativeExact} from '../../../vendor/compatibility/v1/native.mjs';
import {durableReconstructionFile,reconstructionFail} from './local-reconstruction.js';
import {codexConfig,codexToml,verifyCodexRequest,verifyCodexVersion,codexCancellation} from './codex-reconstruction.js';
import type {CodexWorkerRequest} from './codex-reconstruction.js';

type ObjectValue=Record<string,unknown>;
function fail(code:string):never{return reconstructionFail(code);}
function object(value:unknown):ObjectValue{if(!value||typeof value!=='object'||Array.isArray(value))fail('CODEX_PROTOCOL');return value as ObjectValue;}
function at(value:unknown,key:string):unknown{return key.split('.').reduce<unknown>((v,k)=>object(v)[k],value);}
function same(a:unknown,b:unknown){return usabilityStable(a)===usabilityStable(b);}
// App-server materializes optional defaults as null. Non-null extra authority is never discarded.
function withoutNullDefaults(value:unknown):unknown{if(Array.isArray(value))return value.map(withoutNullDefaults);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==null).map(([k,v])=>[k,withoutNullDefaults(v)]));return value;}
export interface CodexGeneration {files:{path:string;content:string}[];tokens:number;threadId:string;turnId:string}
export const CODEX_OUTPUT_SCHEMA={type:'object',additionalProperties:false,required:['files'],properties:{files:{type:'array',minItems:1,maxItems:128,items:{type:'object',additionalProperties:false,required:['path','content'],properties:{path:{type:'string'},content:{type:'string'}}}}}};
/** App-server is the trusted authentication broker. It is never given file-write or tool authority. */
export async function generateCodex(request:CodexWorkerRequest,remainingMs:number):Promise<CodexGeneration>{
  if(remainingMs<=0)fail('CODEX_TIMEOUT');
  const {directory,input,claim}=request,config=codexConfig(input);verifyCodexRequest(request);verifyCodexVersion(input);
  const args=['app-server','--listen','stdio://',...Object.entries(config).flatMap(([k,v])=>['-c',k+'='+codexToml(v)])];
  const stderr=fs.openSync(path.join(directory,'generation.stderr'),'wx',0o600),journal=fs.openSync(path.join(directory,'generation.events.jsonl'),'wx',0o600);
  const child=spawn(input.codex.executable,args,{cwd:path.join(directory,'work'),env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',HOME:os.homedir()},detached:true,stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close').then(()=>undefined);closed.catch(()=>{});
  durableReconstructionFile(path.join(directory,'generation.process.json'),{claimId:claim.claimId,pid:child.pid??null,executableDigest:claim.plan.executor.executableDigest,configurationDigest:claim.plan.executor.configurationDigest});
  const decoder=new StringDecoder('utf8');
  let bytes=0,buffer='',sequence=0,threadId='',turnId='',terminal=false,problem:Error|null=null;
  const resultState:{tokens:number|null;finalText:string|null}={tokens:null,finalText:null};
  const pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void}>();
  let complete!:()=>void,rejectComplete!:(e:Error)=>void;
  const completion=new Promise<void>((resolve,reject)=>{complete=resolve;rejectComplete=reject;});completion.catch(()=>{});
  const kill=()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');};
  const reject=(code:string)=>{if(problem)return;problem=Object.assign(new Error(code),{code});for(const p of pending.values())p.reject(problem);pending.clear();rejectComplete(problem);kill();};
  const consume=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>claim.plan.budget.maxOutputBytes){reject('CODEX_STREAM_LIMIT');return false;}return true;};
  child.stderr.on('data',(b:Buffer)=>{if(consume(b))fs.writeSync(stderr,b);});
  child.on('error',()=>reject('CODEX_START'));child.on('close',()=>{if(!terminal)reject('CODEX_EXECUTOR_EXIT');});
  child.stdin.on('error',()=>reject('CODEX_INPUT_CLOSED'));
  function send(value:unknown){if(problem)throw problem;child.stdin.write(JSON.stringify(value)+'\n');}
  function rpc(method:string,params:unknown){if(problem)return Promise.reject(problem);return new Promise<unknown>((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});send({id,method,params});});}
  const admittedTypes=new Set(['agentMessage','reasoning','userMessage','contextCompaction']);
  function event(m:ObjectValue){
    const method=String(m.method),v=object(m.params);
    if(!['turn/started','turn/completed','item/started','item/completed','thread/tokenUsage/updated','error'].includes(method))return;
    if(!threadId||v.threadId!==threadId)return;
    fs.writeSync(journal,JSON.stringify(m)+'\n');
    if(method==='error'){if(v.willRetry!==true)reject('CODEX_MODEL_ERROR');return;}
    if(method==='turn/started'){const t=object(v.turn);if(typeof t.id!=='string'||(turnId&&turnId!==t.id))return reject('CODEX_TURN_DRIFT');turnId=t.id;return;}
    const eventTurn=(method==='turn/completed'?object(v.turn).id:v.turnId);
    if(eventTurn!==turnId)return reject('CODEX_TURN_DRIFT');
    if(method==='item/started'||method==='item/completed'){
      const item=object(v.item);if(!admittedTypes.has(String(item.type)))return reject('CODEX_UNEXPECTED_TOOL');
      if(method==='item/completed'&&item.type==='agentMessage'&&item.phase==='final_answer'){
        if(typeof item.text!=='string'||resultState.finalText!==null)return reject('CODEX_RESULT');resultState.finalText=item.text;
      }
    }else if(method==='thread/tokenUsage/updated'){
      const total=object(object(v.tokenUsage).total),n=total.totalTokens;
      if(!Number.isSafeInteger(n)||(n as number)<0||(resultState.tokens!==null&&(n as number)<resultState.tokens))return reject('CODEX_USAGE');resultState.tokens=n as number;
      if(resultState.tokens>claim.remaining.tokens)return reject('CODEX_TOKEN_LIMIT');
    }else if(method==='turn/completed'){
      const turn=object(v.turn);if(turn.status!=='completed')return reject(turn.status==='interrupted'?'CODEX_INTERRUPTED':'CODEX_TURN_FAILED');
      terminal=true;complete();
    }
  }
  child.stdout.on('data',(chunk:Buffer)=>{
    if(!consume(chunk))return;buffer+=decoder.write(chunk);let end:number;
    while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
      try{const m=object(JSON.parse(line));if(typeof m.id==='number'&&pending.has(m.id)){const p=pending.get(m.id)!;pending.delete(m.id);if(m.error)p.reject(Object.assign(new Error('CODEX_RPC'),{code:'CODEX_RPC'}));else p.resolve(m.result);}
        else if(m.id!==undefined&&m.method){send({id:m.id,error:{code:-32601,message:'No tool or approval authority in reconstruction generation'}});reject('CODEX_SERVER_REQUEST');}
        else if(m.method)event(m);
      }catch{reject('CODEX_PROTOCOL');}
    }
  });
  const timer=setTimeout(()=>reject('CODEX_TIMEOUT'),remainingMs);
  const cancel=setInterval(()=>{const reason=codexCancellation(directory);if(reason)reject(reason);},25);
  try{
    await rpc('initialize',{clientInfo:{name:'evopilot_reconstruction',version:'0.9.0'},capabilities:{experimentalApi:true}});send({method:'initialized',params:{}});
    const effective=object(object(await rpc('config/read',{includeLayers:false,cwd:path.join(directory,'work')})).config);
    // Verify policy before any inference. Do not retain config/read: it can contain credentials.
    for(const [key,value] of Object.entries(config))if(!same(withoutNullDefaults(at(effective,key)),value))fail('CODEX_CONFIG_DRIFT');
    if(effective.instructions||effective.model_instructions_file||effective.model_catalog_json)fail('CODEX_CONTEXT_UNREVIEWED');
    const servers=object(effective.mcp_servers??{});if(Object.keys(servers).some(k=>object(servers[k]).enabled!==false))fail('CODEX_MCP_ENABLED');
    const started=object(await rpc('thread/start',{model:input.codex.model,modelProvider:'openai',approvalPolicy:'never',permissions:'evopilot_generate',cwd:path.join(directory,'work'),runtimeWorkspaceRoots:[],environments:[],selectedCapabilityRoots:[],dynamicTools:[],ephemeral:false,experimentalRawEvents:false,allowProviderModelFallback:false,
      developerInstructions:'Generate an implementation solely from the supplied specification. Do not use tools, external services, existing project code, or hidden tests. Return only the requested JSON file bundle. Host policy is generic context, not a software specification.'}));
    const t=object(started.thread);if(typeof t.id!=='string'||started.model!==input.codex.model||started.modelProvider!=='openai'||started.approvalPolicy!=='never'||object(started.activePermissionProfile).id!=='evopilot_generate'||!same(started.runtimeWorkspaceRoots,[]))fail('CODEX_ADMISSION');
    if(!Array.isArray(started.instructionSources)||!same([...started.instructionSources].sort(),input.codex.policyFiles.map(f=>f.path).sort()))fail('CODEX_CONTEXT_UNREVIEWED');
    verifyCodexRequest(request);threadId=t.id;
    let cursor:unknown=null;
    do{const inventory=object(await rpc('mcpServerStatus/list',{threadId,cursor,limit:100,detail:'full'}));if(!Array.isArray(inventory.data)||inventory.data.some(x=>{const s=object(x);return s.runtimeStatus!=='disabled'||Object.keys(object(s.tools)).length!==0;}))fail('CODEX_MCP_ENABLED');cursor=inventory.nextCursor;if(cursor!==null)fail('CODEX_MCP_LIMIT');}while(cursor!==null);
    durableReconstructionFile(path.join(directory,'generation.admission.json'),{threadId,model:started.model,provider:started.modelProvider,policy:started.activePermissionProfile,instructionSources:started.instructionSources,policyPins:input.codex.policyFiles,configurationDigest:claim.plan.executor.configurationDigest});
    const prompt=JSON.stringify({task:'Implement the declared behaviors as ES modules for Node.js. Return a flat JSON files array. No tools. No access to original implementation or evaluation oracle.',specifications:input.files,...(input.state?{execution:{node:process.version,state:{kind:input.state.kind,bytes:input.state.bytes},stateDirectoryEnvironment:'EVOPILOT_STATE_DIR',outputReadOnly:true,network:false,childProcesses:false}}:{})});
    const response=object(await rpc('turn/start',{threadId,input:[{type:'text',text:prompt,text_elements:[]}],model:input.codex.model,effort:input.codex.effort,approvalPolicy:'never',permissions:'evopilot_generate',environments:[],runtimeWorkspaceRoots:[],outputSchema:CODEX_OUTPUT_SCHEMA}));
    const tid=object(response.turn).id;if(typeof tid!=='string'||(turnId&&turnId!==tid))fail('CODEX_TURN_DRIFT');turnId=tid;
    durableReconstructionFile(path.join(directory,'generation.turn.json'),{claimId:claim.claimId,threadId,turnId});
    await completion;if(problem)throw problem;
    const {finalText,tokens}=resultState;
    if(finalText===null||tokens===null)fail('CODEX_RESULT_OR_USAGE_MISSING');
    const result=object(JSON.parse(finalText));nativeExact(result,['files']);if(!Array.isArray(result.files)||result.files.length<1||result.files.length>128)fail('CODEX_RESULT');
    const names=new Set<string>();let size=0;const files=result.files.map(raw=>{const f=object(raw);nativeExact(f,['path','content']);if(typeof f.path!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(f.path)||names.has(f.path)||typeof f.content!=='string')fail('CODEX_OUTPUT');names.add(f.path);size+=Buffer.byteLength(f.content);if(size>claim.plan.budget.maxOutputBytes)fail('CODEX_OUTPUT_LIMIT');return {path:f.path,content:f.content};});
    verifyCodexRequest(request);const resultValue={files,tokens,threadId,turnId};durableReconstructionFile(path.join(directory,'generation.result.json'),resultValue);return resultValue;
  }finally{
    clearTimeout(timer);clearInterval(cancel);kill();await closed.catch(()=>{});fs.fsyncSync(journal);fs.fsyncSync(stderr);fs.closeSync(journal);fs.closeSync(stderr);
  }
}
