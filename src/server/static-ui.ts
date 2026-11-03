import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,sep} from 'node:path';
import type {ServerResponse} from 'node:http';
import {exact,record,reject,string} from './errors.js';
/** Public static code only. No filesystem path from a request is ever opened;
 * it must first match the package's complete fixed build manifest. Project data
 * is read exclusively through the scoped authenticated Dashboard endpoints. */
export function serveDashboard(pathname:string,method:string|undefined,res:ServerResponse):boolean{
 if(!['GET','HEAD'].includes(method??''))return false;
 if(pathname==='/'){res.writeHead(302,{location:'/monitor','cache-control':'no-store'});res.end();return true;}
 const page=pathname==='/lifecycle'||pathname==='/monitor';
 if(!page&&!pathname.startsWith('/ui/'))return false;
 const root=fileURLToPath(new URL('../dashboard/',import.meta.url)),manifestPath=join(root,'manifest.json');
 if(!existsSync(manifestPath))reject('DASHBOARD_NOT_BUILT','The selected Runtime package has no built Dashboard',503);
 const stat=lstatSync(manifestPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)reject('DASHBOARD_DISTRIBUTION','Invalid Dashboard build manifest',503);
 const manifest=record(JSON.parse(readFileSync(manifestPath,'utf8')));exact(manifest,['schema','files']);
 if(manifest.schema!=='runtime-dashboard-distribution/v1')reject('DASHBOARD_DISTRIBUTION','Unsupported Dashboard build',503);
 const name=page?'index.html':pathname.slice(4),files=record(manifest.files);
 if(!/^[A-Za-z0-9._/-]+$/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..')||!Object.hasOwn(files,name))reject('NOT_FOUND','Dashboard resource not found',404);
 const pin=record(files[name]);exact(pin,['bytes','sha256','type']);
 const path=join(root,name),file=lstatSync(path);if(!file.isFile()||file.isSymbolicLink()||realpathSync(path)!==realpathSync(root)+sep+name||file.size>2097152)reject('DASHBOARD_DISTRIBUTION','Invalid Dashboard resource',503);
 const bytes=readFileSync(path);if(bytes.length!==pin.bytes||createHash('sha256').update(bytes).digest('hex')!==pin.sha256)reject('DASHBOARD_DISTRIBUTION','Dashboard resource differs from its build',503);
 const type=string(pin.type,128);if(!['text/html; charset=utf-8','text/javascript; charset=utf-8','text/css; charset=utf-8','text/plain; charset=utf-8'].includes(type))reject('DASHBOARD_DISTRIBUTION','Invalid Dashboard resource type',503);
 res.writeHead(200,{'content-type':type,'cache-control':'no-store','referrer-policy':'no-referrer','content-length':bytes.length});res.end(method==='HEAD'?undefined:bytes);return true;
}
