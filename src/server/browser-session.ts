import {randomBytes,timingSafeEqual} from 'node:crypto';
import {canonical,digest,reject,string} from './errors.js';
import {authorize,type Principal} from './security.js';

interface Binding {principal:Principal;projectId:string;origin:string;expiresAt:number;verify?:()=>Principal;}
interface Session extends Binding {csrf:string;}
export const BROWSER_COOKIE='evopilot_runtime_session';
const secret=()=>randomBytes(32).toString('base64url');
const equal=(a:string,b:string)=>timingSafeEqual(Buffer.from(digest(a),'hex'),Buffer.from(digest(b),'hex'));
/** Ephemeral, project-scoped browser sessions. A bearer-authenticated client
 * creates a one-use code; the browser exchanges it in a same-origin POST body.
 * No long-lived service token is copied into a URL, cookie, or browser storage.
 * Restart, expiry, changed principal metadata or credential revocation requires
 * reconnecting. Sessions never extend the original principal's permissions. */
export function createBrowserSessions(current:(id:string)=>Principal|null,clock:()=>number=Date.now){
  const tickets=new Map<string,Binding>(),sessions=new Map<string,Session>();
  function sweep(){for(const map of [tickets,sessions])for(const [id,b]of map)if(b.expiresAt<=clock())map.delete(id);}
  function check(binding:Binding,origin:string):Principal{
    if(binding.expiresAt<=clock()||binding.origin!==origin)reject('BROWSER_SESSION_EXPIRED','Reconnect this browser to the selected Runtime project',401);
    const actor=binding.verify?binding.verify():current(binding.principal.id);
    if(!actor||canonical(actor)!==canonical(binding.principal))reject('BROWSER_SESSION_REVOKED','The original browser authority changed; reconnect',401);
    authorize(actor,binding.projectId,'read',clock());return actor;
  }
  function selected(cookie:string|undefined,origin:string):{key:string;session:Session;actor:Principal}{
    const matches=(cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(BROWSER_COOKIE+'='));
    if(matches.length!==1)reject('UNAUTHENTICATED','Connect this browser to Runtime',401);
    const value=matches[0].slice(BROWSER_COOKIE.length+1);
    if(!/^[A-Za-z0-9_-]{43}$/.test(value))reject('UNAUTHENTICATED','Connect this browser to Runtime',401);
    const key=digest(value),session=sessions.get(key);
    if(!session)reject('UNAUTHENTICATED','Connect this browser to Runtime',401);
    try{return{key,session,actor:check(session,origin)};}catch(error){sessions.delete(key);throw error;}
  }
  return{
    issue(actor:Principal,projectId:string,origin:string,verify?:()=>Principal){
      sweep();authorize(actor,projectId,'read',clock());
      if(tickets.size>=128)reject('BROWSER_LIMIT','Too many pending browser connections',429);
      // Reissuing cannot accumulate unlimited live codes for one principal.
      for(const [id,b]of tickets)if(b.principal.id===actor.id&&b.projectId===projectId)tickets.delete(id);
      const code=secret(),expiresAt=Math.min(clock()+300000,Date.parse(actor.expiresAt));
      tickets.set(digest(code),{principal:JSON.parse(canonical(actor)) as Principal,projectId,origin,expiresAt,verify});
      return{code,expiresAt:new Date(expiresAt).toISOString(),projectId};
    },
    exchange(code:unknown,origin:string){
      sweep();const value=string(code,128),key=digest(value),ticket=tickets.get(key);
      if(!ticket)reject('BROWSER_CODE_INVALID','The connection code is invalid, used, or expired',401);
      check(ticket,origin);if(sessions.size>=128)reject('BROWSER_LIMIT','Too many active browser sessions',429);
      tickets.delete(key);const valueSecret=secret(),csrf=secret();
      const expiresAt=Math.min(clock()+3600000,Date.parse(ticket.principal.expiresAt));
      sessions.set(digest(valueSecret),{...ticket,csrf,expiresAt});
      return{cookie:BROWSER_COOKIE+'='+valueSecret+'; HttpOnly; SameSite=Strict; Path=/api/v1/dashboard; Max-Age='+Math.max(0,Math.floor((expiresAt-clock())/1000)),projectId:ticket.projectId,csrf,expiresAt:new Date(expiresAt).toISOString()};
    },
    authenticate(cookie:string|undefined,origin:string,projectId?:string,csrf?:string){
      const found=selected(cookie,origin);
      if(projectId!==undefined&&projectId!==found.session.projectId)reject('FORBIDDEN','Browser session belongs to another project',403);
      if(csrf!==undefined&&!equal(csrf,found.session.csrf))reject('CSRF','The browser request is missing its exact session proof',403);
      return{actor:found.actor,projectId:found.session.projectId,csrf:found.session.csrf,expiresAt:new Date(found.session.expiresAt).toISOString()};
    },
    close(cookie:string|undefined,origin:string,csrf:string){const found=selected(cookie,origin);if(!equal(csrf,found.session.csrf))reject('CSRF','Invalid browser session proof',403);sessions.delete(found.key);return BROWSER_COOKIE+'=; HttpOnly; SameSite=Strict; Path=/api/v1/dashboard; Max-Age=0';},
    clear(){tickets.clear();sessions.clear();},
  };
}
