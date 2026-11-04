import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {serviceMain} from '../../dist/server/cli.js';
import {compileLifecycle} from '../../dist/lifecycle/compiler.js';
import {pinInstance,requiredChecksDigest} from '../../dist/lifecycle/instance.js';
import {valueDigest} from '../../dist/lifecycle/base.js';
import {lifecycle,yaml} from '../fixtures/lifecycle-v090.mjs';
import {zeroMetrics} from '../../dist/usage/contract.js';

test('native CLI, authenticated HTTP MCP, worker and JSON/Markdown reports use one retained ledger',async()=>{
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-usage-host-')),root=join(dir,'state'),token=randomBytes(32).toString('base64url'),expiresAt='2030-01-01T00:00:00Z';
  const actor={id:'owner',projects:['alpha'],permissions:['read','draft.write'],revision:1,expiresAt};
  const put=(path,value)=>writeFileSync(path,JSON.stringify(value),{mode:0o600});let server,client;
  const run=async args=>{let output='';const code=await serviceMain(args,{write:v=>{output+=v;}});return{code,output};};
  try{
    initializeCredentials(root,'synthetic',[{...actor,tokenDigest:tokenDigest(token)}]);
    const store=new RuntimeStore(root,'synthetic');
    try{
      const definition=compileLifecycle(yaml(lifecycle()),'alpha').effective,revision=valueDigest(definition.semantic),authority={projectId:'alpha',instanceId:'host-instance',definitionRevisionId:revision,semanticDigest:definition.semanticDigest,goalRef:'synthetic:goal',targetRef:'synthetic:target',loopRef:'synthetic:loop',requirementsDigest:requiredChecksDigest(definition),budget:{timeoutSeconds:3600,maxAttempts:4,maxConcurrency:4,maxLoops:4},evidenceRef:'synthetic:authority',revision:'1',expiresAt};
      const instance=pinInstance('host-instance',revision,definition,authority);store.mutate(actor,{projectId:'alpha',operation:'synthetic.seed',requestId:'seed-instance',expectedRevision:0,input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'lifecycle-instance',id:instance.id,value:instance}],value:{synthetic:true},event:{type:'synthetic-seed',data:{synthetic:true}}}));
    }finally{store.close();}
    const source=join(dir,'selected.jsonl');writeFileSync(source,JSON.stringify({type:'session_meta',payload:{id:'synthetic-host-thread',cli_version:'synthetic-test',model_provider:'synthetic'}})+'\n',{mode:0o600});
    const inspected=await run(['usage-inspect','--source',source]);assert.equal(inspected.code,0);const identity=JSON.parse(inspected.output).source;
    const grantRef=join(dir,'grant.json');put(grantRef,{schema:'runtime-codex-usage-grant/v1',id:'host-source',workspaceId:'synthetic',projectId:'alpha',principalId:'owner',principalRevision:1,path:source,identity,epoch:'one',agentRole:'main',parentThreadId:null,baseline:zeroMetrics(),baselineEvidence:'synthetic:new-thread',expiresAt});
    assert.equal((await run(['usage-grant','--state-root',root,'--workspace-id','synthetic','--grant-ref',grantRef])).code,0);
    server=await startRuntimeServer({stateRoot:root,workspaceId:'synthetic'});
    const tokenRef=join(dir,'token.json'),connectionRef=join(dir,'connection.json');put(tokenRef,{schema:'runtime-client-credential/v1',workspaceId:'synthetic',principalId:'owner',projectId:'alpha',token});put(connectionRef,{schema:'runtime-host-connection/v1',origin:server.url,workspaceId:'synthetic',projectId:'alpha',principalId:'owner',serviceId:server.identity.serviceId,version:server.identity.version,tokenRef});
    client=new Client({name:'synthetic-usage-client',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}));
    const call=async(operation,input={},write=false)=>{
      let expectedRevision;
      if(write){const r=await call('runtime.status');expectedRevision=r.result.revision;}
      const result=await client.callTool({name:write?'runtime_write':'runtime_read',arguments:{operation,projectId:'alpha',input,...(write?{requestId:randomBytes(12).toString('hex'),expectedRevision}:{})}});assert.notEqual(result.isError,true,result.content?.[0]?.text);return JSON.parse(result.content[0].text);
    };
    assert.equal((await call('usage.source.register',{sourceId:'host-source'},true)).result.result.id,'host-source');
    await call('usage.attribution.bind',{id:'host-binding',sourceId:'host-source',afterSequence:0,throughSequence:null,targetVersion:'0.9.0',targetRef:'synthetic:target',instanceId:'host-instance',stageId:'implementation',baseStage:'implementation',taskId:'coding',attemptId:'original',workType:'coding'},true);
    appendFileSync(source,JSON.stringify({type:'turn_context',payload:{turn_id:'turn-one',model:'synthetic-model'}})+'\n'+JSON.stringify({type:'event_msg',ordinal:1,timestamp:new Date().toISOString(),payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:20,total_tokens:120,cached_input_tokens:50,reasoning_output_tokens:5},last_token_usage:{input_tokens:100,output_tokens:20,total_tokens:120,cached_input_tokens:50,reasoning_output_tokens:5}}}})+'\n');
    let report;const deadline=Date.now()+6000;do{report=(await call('usage.report.read',{targetVersion:'0.9.0'})).result;if(report.counts.total.recorded===120)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
    assert.equal(report.counts.total.recorded,120);assert.equal(report.counts.cachedInput.recorded,50);assert.equal(report.counts.reasoningOutput.recorded,5);assert.equal(report.counts.cacheWriteInput.recorded,null);
    const query=join(dir,'query.json');put(query,{targetVersion:'0.9.0'});
    const json=await run(['usage-report','--connection-ref',connectionRef,'--query-ref',query,'--format','json']);assert.equal(json.code,0);assert.deepEqual(JSON.parse(json.output).result.counts,report.counts);
    const markdown=await run(['usage-report','--connection-ref',connectionRef,'--query-ref',query,'--format','markdown']);assert.equal(markdown.code,0);assert.match(markdown.output,/已记录消耗/);assert.match(markdown.output,/120/);assert(!markdown.output.includes(token));
    const snapshot=(await call('usage.snapshot.create',{targetVersion:'0.9.0'},true)).result.result.id;
    const frozen=(await call('usage.snapshot.read',{id:snapshot})).result;
    await call('usage.source.revoke',{sourceId:'host-source'},true);assert.equal((await call('usage.sources.list')).result.sources[0].revoked,true);
    assert.deepEqual((await call('usage.snapshot.read',{id:snapshot})).result,frozen);
    const auth=JSON.parse(readFileSync(join(root,'auth.json')));auth.principals[0].expiresAt='2000-01-01T00:00:00Z';put(join(root,'auth.json'),auth);
    assert.equal((await fetch(server.url+'/api/v1/status?projectId=alpha',{headers:{authorization:'Bearer '+token}})).status,401);
  }finally{await client?.close();await server?.close();rmSync(dir,{recursive:true,force:true});}
});
