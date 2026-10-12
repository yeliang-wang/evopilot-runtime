import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeService } from '../../src/service.mjs';

const scope={visibility:'private',projectId:'alpha'};
test('boundary: provider construction rejects unknown keys, getters and non-callbacks without effects',()=>{
  const options={workspaceRoot:'/inert/not-opened',workspaceId:'test'};
  let calls=0;const callback=()=>{calls++;throw Error('must not invoke');};
  const accessor=Object.defineProperty({},'execute',{enumerable:true,get:callback});
  const hidden=Object.defineProperty({},'execute',{value:callback});
  const proxy=new Proxy({},{getPrototypeOf:callback,ownKeys:callback,get:callback});
  for(const value of [null,[],new Date(),Object.create({execute:callback}),accessor,hidden,proxy,{unknown:callback},{[Symbol('provider')]:callback},{execute:undefined},{execute:null},{execute:'command'},{resolveOntology:{}},{resolveHarness:1},{inspectReceipt:false},{timeoutMs:null},{timeoutMs:0},{timeoutMs:30001},{timeoutMs:1.5},{timeoutMs:NaN}]) {
    assert.throws(()=>createRuntimeService(options,value),{code:'INVALID_PROVIDER'});
  }
  for(const timeoutMs of [1,30000]) {
    const providers=Object.assign(Object.create(null),{resolveOntology:callback,resolveHarness:callback,execute:callback,inspectReceipt:callback,timeoutMs});
    const service=createRuntimeService(options,providers);assert.equal(service.capabilities().authority,false);service.close();
  }
  assert.equal(calls,0);
});
test('pure discovery; identity, scopes, CAS across instances, restart and closed writes',t=>{
  const parent=mkdtempSync(join(realpathSync(tmpdir()),'runtime-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const options={workspaceRoot:join(parent,'workspace'),workspaceId:'test'};
  const a=createRuntimeService(options),b=createRuntimeService(options);t.after(()=>{a.close();b.close();});
  assert.equal(existsSync(options.workspaceRoot),false);assert.equal(a.capabilities().authority,false);
  a.initialize();b.initialize();
  assert.deepEqual(JSON.parse(readFileSync(join(options.workspaceRoot,'workspace.json'))),{schema:'evopilot-workspace/v1',id:'test',canonicalRoot:options.workspaceRoot,ownerUid:process.getuid()});
  assert.equal(statSync(join(options.workspaceRoot,'state/runtime/runtime.db')).mode&0o777,0o600);
  const request={operation:'project.create',scope,input:{name:'Alpha'},requestId:'create',expectedRevision:0};
  const receipt=a.execute(request);assert.deepEqual(b.execute(request),receipt);
  assert.throws(()=>b.execute({...request,requestId:'other'}),{code:'REVISION_CONFLICT'});
  assert.throws(()=>b.execute({...request,input:{name:'Changed'}}),{code:'REQUEST_CONFLICT'});
  assert.deepEqual(b.execute({operation:'project.list',scope:{...scope,projectId:'beta'},input:{}}),[]);
  assert.throws(()=>b.execute({operation:'receipt.inspect',scope:{...scope,projectId:'beta'},input:{requestId:'create'}}),{code:'NOT_FOUND'});
  a.close();assert.throws(()=>a.execute(request),{code:'CLOSED'});b.close();
  const c=createRuntimeService(options);c.initialize();assert.deepEqual(c.execute({operation:'receipt.inspect',scope,input:{requestId:'create'}}),receipt);c.close();
});
test('unknown, linked and wrong-identity workspaces are preserved',t=>{
  const parent=mkdtempSync(join(realpathSync(tmpdir()),'runtime-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const root=join(parent,'unknown');mkdirSync(root,{mode:0o700});writeFileSync(join(root,'retained'),'data');
  assert.throws(()=>createRuntimeService({workspaceRoot:root,workspaceId:'test'}).initialize(),{code:'UNKNOWN_WORKSPACE'});
  const safe=join(parent,'safe'),s=createRuntimeService({workspaceRoot:safe,workspaceId:'test'});s.initialize();s.close();
  assert.throws(()=>createRuntimeService({workspaceRoot:safe,workspaceId:'wrong'}).initialize(),{code:'IDENTITY_MISMATCH'});
  symlinkSync(safe,join(parent,'linked'));assert.throws(()=>createRuntimeService({workspaceRoot:join(parent,'linked'),workspaceId:'test'}).initialize(),{code:'UNSAFE_WORKSPACE'});
});
