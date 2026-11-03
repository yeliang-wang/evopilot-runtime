import assert from 'node:assert/strict';
import {readFileSync,lstatSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,resolve,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
export function verifySeeCode(){
 const bytes=readFileSync(join(root,'provenance/seecode.json')),manifest=JSON.parse(bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'ef93ea6df746e6dfb15145c5168d1017394c3f109d3446c3ab8629415090cbf6','SeeCode publisher pin changed');
 assert.equal(manifest.schema,'runtime-seecode-renderer/v1');assert.equal(manifest.commit,'9967db28e86e0e212d4ddf5a60f90fe62f3436c0');assert.equal(manifest.version,'0.6.3');assert.equal(manifest.license,'MIT');
 const files=[];function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);assert(!entry.isSymbolicLink());if(entry.isDirectory())walk(path);else files.push(relative(root,path));}}walk(join(root,'dashboard/vendor/seecode'));
 assert.deepEqual(files.sort(),Object.keys(manifest.files).sort());
 for(const [name,pin]of Object.entries(manifest.files)){const file=readFileSync(join(root,name));assert.equal(file.length,pin.bytes);assert.equal(createHash('sha256').update(file).digest('hex'),pin.sha256);assert.equal(createHash('sha1').update('blob '+file.length+'\0').update(file).digest('hex'),pin.gitBlob);if(name.endsWith('.mjs')){const text=file.toString();assert.doesNotMatch(text,/\b(?:eval|fetch|require)\s*\(|from\s+['"]node:/);for(const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)){assert(match[1].startsWith('.'));assert(Object.hasOwn(manifest.files,relative(root,resolve(root,name,'..',match[1]))));}}}
 return manifest;
}
export function checkDashboard(){
 verifySeeCode();const typed=spawnSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p','dashboard/tsconfig.json'],{cwd:root,encoding:'utf8'});assert.ifError(typed.error);assert.equal(typed.status,0,typed.stdout+typed.stderr);
 for(const name of ['api.ts','model.ts','types.ts','main.tsx','App.tsx','Editor.tsx','Monitor.tsx','Graph.tsx']){const text=readFileSync(join(root,'dashboard/src',name),'utf8');assert.doesNotMatch(text,/@ts-(?:ignore|nocheck)|\beval\s*\(|dangerouslySetInnerHTML|\bfetch\s*\(\s*['"]https?:/);}
 const m=JSON.parse(readFileSync(join(root,'dist/dashboard/manifest.json')));assert.equal(m.schema,'runtime-dashboard-distribution/v1');assert(m.files['index.html']);
 for(const [name,pin]of Object.entries(m.files)){const path=join(root,'dist/dashboard',name);assert(lstatSync(path).isFile());const bytes=readFileSync(path);assert.equal(bytes.length,pin.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.sha256);}
}
