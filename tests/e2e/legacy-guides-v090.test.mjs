import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,readdirSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {getGuide,scenarios} from '../../dist/host/guidance/guide.js';
import {callGuide,GUIDE_TOOL_NAME} from '../../dist/host/guide.js';
import {createStdioBridge} from '../../dist/host/bridge.js';

const repo=realpathSync(fileURLToPath(new URL('../../',import.meta.url))),bridge=join(repo,'dist/host/bridge.js');
const unwrap=result=>JSON.parse(result.content[0].text);

test('all retained scenario identifiers return isolated current guidance with separate historical provenance',()=>{
  const names=['asset-consumption','usability-assessment','controlled-reconstruction','reconstruction-recovery','readable-assets','draft-preflight','planning-explore','planning-review','planning-resume','planning-handoff','operations-profile','response-assess','response-execute','response-recovery','response-learning','online-setup','online-observe','online-repair','online-regression','online-recovery','onboarding','ontology-forward','ontology-reverse','harness-quality','runtime-handoff','recovery','runtime-feedback','asset-feedback-review','feedback-recovery','retained-ontology'];
  assert.deepEqual(scenarios.filter(name=>!name.startsWith('V')).sort(),names.sort());
  for(const [version,count] of [['03',6],['04',3],['05',5],['06',5],['07',6],['08',6]]){
    assert.equal(scenarios.filter(name=>name.startsWith('V'+version+'-')).length,count);
    for(let i=1;i<=count;i++)assert(scenarios.includes(`V${version}-U${String(i).padStart(2,'0')}`));
  }
  assert.equal(new Set(scenarios).size,scenarios.length);
  for(const name of scenarios){
    const response=callGuide({scenario:name}),guide=unwrap(response).result;
    assert.equal(response.isError,undefined);assert.equal(guide.authority,false);assert.equal(guide.capabilitiesInspected,false);assert.equal(guide.acceptance,'NOT_INFERRED');
    if(guide.useCase){assert.equal(guide.useCase.testsReferenceOrigin.currentAcceptance,false);if(name.startsWith('V02-'))assert.equal(guide.useCase.historicalReadOnly,true);}
    guide.steps.push('MUTATED');assert(!getGuide(name).steps.includes('MUTATED'));
  }
});

test('current content scenarios and old aliases retain v2 L3 without execution or environment prerequisites',()=>{
  for(const name of ['ontology-forward','ontology-reverse','usability-assessment','asset-consumption','V08-U02','V08-U03','V03-U02','V03-U03']){
    const guide=getGuide(name),steps=guide.steps.join('\n');
    assert.match(steps,/NOT_REQUESTED/);assert.doesNotMatch(steps,/L3 requires actual independent reconstruction|L3 requires independent reconstruction|Two independent clean passing attempts are required for L3/);
    assert(!guide.operations.includes('reconstruction.dispatch'));assert(!guide.operations.includes('collection.execute'));
  }
  assert.match(getGuide('controlled-reconstruction').steps.join('\n'),/separate reconstruction request/);
  assert.match(getGuide('reconstruction-recovery').steps.join('\n'),/not permission to dispatch again/);
  for(const value of [{scenario:'__proto__'},{scenario:'constructor'},{scenario:'unknown'},{scenario:'onboarding',humanDecision:'APPROVE'},{scenario:42},null])assert.equal(callGuide(value).isError,true);
});

test('documentation references resolve within Runtime or the exact published owner inventory',()=>{
  const guide=getGuide('onboarding');
  for(const path of guide.installedReferences){assert(!path.startsWith('projects/')&&!path.startsWith('node_modules/'));assert(existsSync(join(repo,path)),path);}
  for(const owner of guide.ownerReferences){
    const inventory=JSON.parse(readFileSync(join(repo,'provenance/published-owners',`${owner.owner}-${owner.version}.json`),'utf8'));
    for(const path of owner.paths)assert(path.endsWith('/')?Object.keys(inventory.files).some(file=>file.startsWith(path)):inventory.files[path],`${owner.owner}:${path}`);
  }
  for(const name of scenarios){const steps=getGuide(name).steps.join('\n');for(const match of steps.matchAll(/docs\/[a-zA-Z0-9_./-]+\.md/g))assert(existsSync(join(repo,match[0])),`${name}:${match[0]}`);}
});

test('MCP initialization and guide calls never contact the injected service or owner routes',async()=>{
  let status=0,requests=0,ownerCalls=0,closed=0;
  const fake={connection:{version:'0.8.3'},async status(){status++;throw Error('offline');},async request(){requests++;throw Error('offline');}};
  const owners={capabilities(){ownerCalls++;throw Error('must not inspect');},async call(){ownerCalls++;throw Error('must not call');},async close(){closed++;}};
  const server=createStdioBridge(fake,owners,true),client=new Client({name:'synthetic-passive-guidance',version:'1'}),[left,right]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(left);await client.connect(right);
    const result=unwrap(await client.callTool({name:GUIDE_TOOL_NAME,arguments:{scenario:'V08-U03'}}));
    assert.equal(result.connectionAccessed,false);assert.equal(result.result.guideName,'usability-assessment');assert.deepEqual([status,requests,ownerCalls],[0,0,0]);
    assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),[GUIDE_TOOL_NAME]);assert.equal(status,1);assert.equal(ownerCalls,0);
    const after=unwrap(await client.callTool({name:GUIDE_TOOL_NAME,arguments:{scenario:'onboarding'}}));assert.equal(after.passive,true);assert.equal(status,1);
  }finally{await client.close();await server.close();}
  assert.equal(closed,1);
});

test('actual stdio entry serves guides without configuration and survives a missing configured Workspace',async()=>{
  const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-offline-guide-'));
  try{
    for(const args of [[],['--legacy-only','--connection-ref',join(root,'missing.json'),'--owner-config-ref',join(root,'missing-owner.json')]]){
      const client=new Client({name:'synthetic-stdio-offline-guide',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[bridge,...args],cwd:root,stderr:'pipe'});let stderr='';transport.stderr?.on('data',c=>stderr+=c);
      try{
        await client.connect(transport);
        const guide=unwrap(await client.callTool({name:GUIDE_TOOL_NAME,arguments:{scenario:'ontology-reverse'}}));assert.equal(guide.connectionAccessed,false);assert.equal(guide.result.authority,false);
        assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),[GUIDE_TOOL_NAME]);
        const blocked=await client.callTool({name:'evopilot_v01_activate',arguments:{}});assert.equal(blocked.isError,true);
        assert.equal(unwrap(await client.callTool({name:GUIDE_TOOL_NAME,arguments:{scenario:'recovery'}})).result.guideName,'recovery');
        assert.deepEqual(readdirSync(root),[],'no Workspace, credential, provider or service file is created');
      }finally{await client.close();}
      assert.equal(stderr.replace(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g,''),'');
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
