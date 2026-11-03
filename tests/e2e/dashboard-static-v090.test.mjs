import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {serviceMain} from '../../dist/server/cli.js';
test('only two static pages and fixed distribution resources are public; scoped data remains authenticated',async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-static-')),stateRoot=join(root,'state'),token=randomBytes(32).toString('base64url');initializeCredentials(stateRoot,'static',[{id:'reader',projects:['alpha'],permissions:['read'],revision:1,expiresAt:'2030-01-01T00:00:00Z',tokenDigest:tokenDigest(token)}]);const server=await startRuntimeServer({stateRoot,workspaceId:'static'});
 try{for(const path of ['/lifecycle','/monitor']){const r=await fetch(server.url+path);assert.equal(r.status,200);assert(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"));const html=await r.text();assert.match(html,/id="root"/);const script=html.match(/src="(\/ui\/assets\/[^\"]+\.js)"/)[1];const js=await fetch(server.url+script);assert.equal(js.status,200);assert(js.headers.get('content-type').startsWith('text/javascript'));}
  assert.equal((await fetch(server.url+'/ui/seecode.css')).status,200);assert.equal((await fetch(server.url+'/ui/SEECODE-LICENSE.txt')).status,200);
  for(const path of ['/ui/manifest.json','/ui/src/main.tsx','/ui/%2e%2e/auth.json'])assert.notEqual((await fetch(server.url+path)).status,200);
  for(const path of ['/api/v1/dashboard/monitor','/api/v1/status?projectId=alpha'])assert.equal((await fetch(server.url+path)).status,401);
  const credential=join(root,'token.json'),connection=join(root,'connection.json');writeFileSync(credential,JSON.stringify({schema:'runtime-client-credential/v1',workspaceId:'static',projectId:'alpha',principalId:'reader',token}),{mode:0o600});writeFileSync(connection,JSON.stringify({schema:'runtime-host-connection/v1',origin:server.url,workspaceId:'static',projectId:'alpha',principalId:'reader',serviceId:server.identity.serviceId,version:server.identity.version,tokenRef:credential}),{mode:0o600});
  let output='';assert.equal(await serviceMain(['browser-code','--connection-ref',connection],{write:v=>output+=v}),0);const code=JSON.parse(output);assert.equal(code.url,server.url+'/monitor');assert(!output.includes(token));assert.equal(code.oneUse,true);
  const exchanged=await fetch(server.url+'/api/v1/dashboard/session',{method:'POST',headers:{origin:server.url,'content-type':'application/json'},body:JSON.stringify({code:code.code})});assert.equal(exchanged.status,200);assert(exchanged.headers.get('set-cookie').includes('HttpOnly'));
 }finally{await server.close();rmSync(root,{recursive:true,force:true});}
});
