import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserSessions,BROWSER_COOKIE} from '../../dist/server/browser-session.js';

const origin='http://127.0.0.1:34567';
function fixture(){let now=Date.parse('2026-11-03T00:00:00Z'),actor={id:'reader',revision:1,projects:['alpha','beta'],permissions:['read'],expiresAt:'2026-11-04T00:00:00Z'};const service=createBrowserSessions(()=>actor,()=>now);return{service,get actor(){return actor;},set actor(value){actor=value;},tick(ms){now+=ms;}};}
function connect(f){const t=f.service.issue(f.actor,'alpha',origin),s=f.service.exchange(t.code,origin);return{...s,cookie:s.cookie.split(';')[0]};}
test('browser exchange is one use, scope bound, origin bound, and does not return a service bearer',()=>{
 const f=fixture(),code=f.service.issue(f.actor,'alpha',origin);assert.throws(()=>f.service.exchange(code.code,'http://localhost:34567'),{code:'BROWSER_SESSION_EXPIRED'});
 const session=f.service.exchange(code.code,origin);assert.match(session.cookie,/HttpOnly; SameSite=Strict; Path=\/api\/v1\/dashboard/);assert(!session.cookie.includes(code.code));
 assert.throws(()=>f.service.exchange(code.code,origin),{code:'BROWSER_CODE_INVALID'});const cookie=session.cookie.split(';')[0];assert.equal(f.service.authenticate(cookie,origin).actor.id,'reader');
 assert.throws(()=>f.service.authenticate(cookie,origin,'beta'),{code:'FORBIDDEN'});assert.throws(()=>f.service.authenticate(cookie,origin,'alpha','wrong'),{code:'CSRF'});
 assert.equal(f.service.authenticate(cookie,origin,'alpha',session.csrf).projectId,'alpha');assert.throws(()=>f.service.authenticate(cookie+'; '+cookie,origin),{code:'UNAUTHENTICATED'});
});
test('code expiry, replacement, session expiry, principal changes and restart fail closed',()=>{
 const f=fixture(),old=f.service.issue(f.actor,'alpha',origin),latest=f.service.issue(f.actor,'alpha',origin);assert.throws(()=>f.service.exchange(old.code,origin),{code:'BROWSER_CODE_INVALID'});f.tick(300001);assert.throws(()=>f.service.exchange(latest.code,origin),{code:'BROWSER_CODE_INVALID'});
 let s=connect(f);f.actor={...f.actor,revision:2};assert.throws(()=>f.service.authenticate(s.cookie,origin),{code:'BROWSER_SESSION_REVOKED'});
 s=connect(f);f.tick(3600001);assert.throws(()=>f.service.authenticate(s.cookie,origin),{code:'BROWSER_SESSION_EXPIRED'});
 s=connect(f);f.service.clear();assert.throws(()=>f.service.authenticate(s.cookie,origin),{code:'UNAUTHENTICATED'});
});
test('credential verifier is repeated and missing/invalid cookie or logout cannot alter another session',()=>{
 const f=fixture();let valid=true,calls=0;const ticket=f.service.issue(f.actor,'alpha',origin,()=>{calls++;if(!valid)throw Object.assign(new Error('revoked'),{code:'UNAUTHENTICATED'});return f.actor;});
 const session=f.service.exchange(ticket.code,origin);assert.equal(calls,1);f.service.authenticate(session.cookie.split(';')[0],origin);assert.equal(calls,2);valid=false;assert.throws(()=>f.service.authenticate(session.cookie.split(';')[0],origin),{code:'UNAUTHENTICATED'});
 const s=connect(f);assert.throws(()=>f.service.close(s.cookie,origin,'bad'),{code:'CSRF'});assert(f.service.close(s.cookie,origin,s.csrf).includes('Max-Age=0'));assert.throws(()=>f.service.authenticate(s.cookie,origin),{code:'UNAUTHENTICATED'});
 for(const cookie of [undefined,'',BROWSER_COOKIE+'=a',BROWSER_COOKIE+'='+('a'.repeat(43))])assert.throws(()=>f.service.authenticate(cookie,origin),{code:'UNAUTHENTICATED'});
});
test('session proof cannot increase permissions or retain a removed project',()=>{
 const f=fixture(),s=connect(f);assert.deepEqual(f.service.authenticate(s.cookie,origin).actor.permissions,['read']);f.actor={...f.actor,projects:['beta']};assert.throws(()=>f.service.authenticate(s.cookie,origin),{code:'BROWSER_SESSION_REVOKED'});
 assert.throws(()=>f.service.issue(f.actor,'alpha',origin),{code:'FORBIDDEN'});
});
