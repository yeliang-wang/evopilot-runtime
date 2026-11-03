// Synthetic private projects with real files/processes and protected Host
// routes. Installed stdio is a separate probe; no semantic or final acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {upgradeWorkspaceProject} from '../../dist/compat/project/upgrade.js';
import {inspectProjectTemplate} from '../../dist/compat/project/templates.js';
import {createProjectHostRoutes} from '../../dist/host/project/routes.js';
import {codeRoot} from '../../dist/compat/project/files.js';

const write=(p,v)=>fs.writeFileSync(p,typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v),{mode:0o600});
const input={requestId:'upgrade-one',expectedTemplateVersion:'0.1.1',targetTemplateVersion:'0.2.0'};
function fixture(t,version='0.1.1'){
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-template-')),projectRoot=join(root,'project'),stateRoot=join(root,'state'),workspaceId='synthetic-template';
 for(const p of [projectRoot,stateRoot])fs.mkdirSync(p,{mode:0o700});
 write(join(projectRoot,'workspace-project.json'),{schema:'evopilot-workspace-project/v1',id:workspaceId,templateVersion:version,specifications:{ontology:'v1',harness:'v1'}});
 write(join(stateRoot,'workspace.json'),{schema:'evopilot-workspace/v1',id:workspaceId,canonicalRoot:stateRoot,ownerUid:process.getuid()});write(join(stateRoot,'unchanged.txt'),'preserved owner evidence');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,projectRoot,stateRoot,workspaceId,installationRoot:codeRoot};
}
const marker=f=>JSON.parse(fs.readFileSync(join(f.projectRoot,'workspace-project.json')));

test('explicit template upgrade preserves customized files and state, creates only missing template files and retains original marker',async t=>{
 const f=fixture(t),original=fs.readFileSync(join(f.projectRoot,'workspace-project.json')),template=inspectProjectTemplate(),unchanged=template.files.find(x=>x.relative==='.gitignore');
 write(join(f.projectRoot,'README.md'),'my own workflow');write(join(f.projectRoot,'local-notes.txt'),'private local notes');write(join(f.projectRoot,'.gitignore'),unchanged.bytes);
 const result=await upgradeWorkspaceProject(f,input);assert.equal(result.schema,'runtime-template-upgrade/v1');assert.equal(result.status,'UPGRADED');assert.equal(result.authority,false);assert.equal(result.templateDigest,template.digest);
 assert.deepEqual(result.customized,['README.md']);assert.deepEqual(result.unchanged,['.gitignore']);assert.equal(result.created.length,4);assert.equal(marker(f).templateVersion,'0.2.0');assert.deepEqual(fs.readFileSync(result.markerBackupPath),original);
 assert.equal(fs.readFileSync(join(f.projectRoot,'README.md'),'utf8'),'my own workflow');assert.equal(fs.readFileSync(join(f.projectRoot,'local-notes.txt'),'utf8'),'private local notes');assert.equal(fs.readFileSync(join(f.stateRoot,'unchanged.txt'),'utf8'),'preserved owner evidence');
 for(const file of template.files.filter(x=>x.relative!=='README.md'))assert.deepEqual(fs.readFileSync(join(f.projectRoot,file.relative)),file.bytes);
 const replay=await upgradeWorkspaceProject(f,input);assert.deepEqual(replay,{...result,reused:true});assert.deepEqual(fs.readFileSync(result.markerBackupPath),original);
 await assert.rejects(upgradeWorkspaceProject(f,{...input,expectedTemplateVersion:'0.2.0'}),{code:'TEMPLATE_UPGRADE_CONFLICT'});
});

test('a current template still repairs missing files without interpreting version as asset approval or Lifecycle activation',async t=>{
 const f=fixture(t,'0.2.0');write(join(f.projectRoot,'README.md'),'custom');const result=await upgradeWorkspaceProject(f,{...input,expectedTemplateVersion:'0.2.0'});
 assert.equal(result.status,'CURRENT');assert.equal(result.created.length,5);assert.equal(result.authority,false);assert.deepEqual(fs.readdirSync(f.stateRoot).sort(),['unchanged.txt','workspace.json']);assert(!fs.existsSync(join(f.projectRoot,'lifecycle.yaml')));
});

test('original call shape is permission-bound in the Host, without granting other project helpers',async t=>{
 const f=fixture(t),context={projectRoot:f.projectRoot,stateRoot:f.stateRoot,workspaceId:f.workspaceId};let active=true;
 const guard=()=>{if(!active)throw Object.assign(Error('revoked'),{code:'OWNER_HOST_CHANGED'});};
 const denied=createProjectHostRoutes(context,'project-a',{root:f.projectRoot,calls:['workspace:inspect']},{},guard);
 await assert.rejects(denied.workspace('template.upgrade',{expectedTemplateVersion:'0.1.1',targetTemplateVersion:'0.2.0'},'one'),{code:'OWNER_HOST_CALL_FORBIDDEN'});assert.equal(marker(f).templateVersion,'0.1.1');
 const routes=createProjectHostRoutes(context,'project-a',{root:f.projectRoot,calls:['workspace:template.upgrade']},{},guard);
 await assert.rejects(routes.workspace('template.upgrade',{expectedTemplateVersion:'0.1.1',targetTemplateVersion:'0.2.0',projectRoot:'/elsewhere'},'one'),{code:'INVALID_FIELDS'});
 const upgraded=await routes.workspace('template.upgrade',{expectedTemplateVersion:'0.1.1',targetTemplateVersion:'0.2.0'},'one');assert.equal(upgraded.status,'UPGRADED');
 await assert.rejects(routes.workspace('bind',{projectId:'project-a'},'two'),{code:'OWNER_HOST_CALL_FORBIDDEN'});
 active=false;await assert.rejects(routes.workspace('template.upgrade',{expectedTemplateVersion:'0.2.0',targetTemplateVersion:'0.2.0'},'two'),{code:'OWNER_HOST_CHANGED'});
});

test('foreign identities, unsupported versions and symlink targets cannot replace any user file',async t=>{
 const f=fixture(t),outside=join(f.root,'outside');fs.mkdirSync(outside,{mode:0o700});write(join(outside,'keep.txt'),'keep');fs.symlinkSync(outside,join(f.projectRoot,'docs'));
 await assert.rejects(upgradeWorkspaceProject(f,input),{code:'SYMLINK'});assert.deepEqual(fs.readdirSync(outside),['keep.txt']);assert.equal(marker(f).templateVersion,'0.1.1');
 await assert.rejects(upgradeWorkspaceProject(f,{...input,targetTemplateVersion:'1.0.0'}),{code:'TEMPLATE_VERSION'});
 await assert.rejects(upgradeWorkspaceProject({...f,workspaceId:'foreign'},input),{code:'TEMPLATE_UPGRADE_IDENTITY'});
 assert(!fs.existsSync(join(f.projectRoot,'README.md')));
});

test('an interrupted exclusive file publish resumes only the retained plan and matching partial files',async t=>{
 const f=fixture(t),publish=fs.linkSync;let failed=false;
 fs.linkSync=(from,to,...rest)=>{if(!failed&&to===join(f.projectRoot,'docs/storage.md')){failed=true;throw Object.assign(Error('synthetic interruption'),{code:'EIO'});}return publish(from,to,...rest);};
 try{await assert.rejects(upgradeWorkspaceProject(f,input),{code:'EIO'});}finally{fs.linkSync=publish;}
 assert(failed);assert.equal(marker(f).templateVersion,'0.1.1');const partial=fs.readFileSync(join(f.projectRoot,'.gitignore'));write(join(f.projectRoot,'.gitignore'),'changed after interruption');
 await assert.rejects(upgradeWorkspaceProject(f,input),{code:'TEMPLATE_UPGRADE_CONFLICT'});assert.equal(fs.readFileSync(join(f.projectRoot,'.gitignore'),'utf8'),'changed after interruption');
 fs.writeFileSync(join(f.projectRoot,'.gitignore'),partial);const result=await upgradeWorkspaceProject(f,input);assert.equal(result.reused,true);assert.equal(marker(f).templateVersion,'0.2.0');
});

test('actual process death releases the file transaction and an exact original request resumes after restart',async t=>{
 const f=fixture(t),contextRef=join(f.root,'context.json');write(contextRef,f);
 const script=join(f.root,'crash.mjs');write(script,`import fs from 'node:fs';import {upgradeWorkspaceProject} from ${JSON.stringify(pathToFileURL(join(codeRoot,'dist/compat/project/upgrade.js')).href)};const c=JSON.parse(fs.readFileSync(process.argv[2])),publish=fs.linkSync;fs.linkSync=(from,to,...rest)=>{const result=publish(from,to,...rest);if(to===c.projectRoot+'/docs/storage.md')process.kill(process.pid,'SIGKILL');return result;};await upgradeWorkspaceProject(c,${JSON.stringify(input)});`);
 const child=spawnSync(process.execPath,[script,contextRef],{encoding:'utf8',timeout:15000});assert.equal(child.signal,'SIGKILL');assert.equal(marker(f).templateVersion,'0.1.1');assert(fs.existsSync(join(f.projectRoot,'docs/storage.md')));
 const result=await upgradeWorkspaceProject(f,input);assert.equal(result.reused,true);assert.equal(result.status,'UPGRADED');assert.equal(marker(f).templateVersion,'0.2.0');
});

test('historical parent upgrade records are retained and never relabeled with the independent template digest',async t=>{
 const f=fixture(t),root=join(f.projectRoot,'.evopilot-template-upgrades');fs.mkdirSync(root,{mode:0o700});const old={schema:'evopilot-template-upgrade/v1',requestId:input.requestId,installationDigest:'a'.repeat(64),historical:true};write(join(root,input.requestId+'.json'),old);
 await assert.rejects(upgradeWorkspaceProject(f,input),{code:'SCHEMA'});assert.deepEqual(JSON.parse(fs.readFileSync(join(root,input.requestId+'.json'))),old);assert.equal(marker(f).templateVersion,'0.1.1');
 assert.equal((await upgradeWorkspaceProject(f,{...input,requestId:'independent-request'})).status,'UPGRADED');assert.deepEqual(JSON.parse(fs.readFileSync(join(root,input.requestId+'.json'))),old);
});

test('a custom file created concurrently after preflight wins over template publication and is never overwritten',async t=>{
 const f=fixture(t),publish=fs.linkSync;let raced=false;
 fs.linkSync=(from,to,...rest)=>{if(!raced&&to===join(f.projectRoot,'README.md')){raced=true;write(to,'new user-authored content');}return publish(from,to,...rest);};
 try{await assert.rejects(upgradeWorkspaceProject(f,input),{code:'TEMPLATE_UPGRADE_CONFLICT'});}finally{fs.linkSync=publish;}
 assert(raced);assert.equal(fs.readFileSync(join(f.projectRoot,'README.md'),'utf8'),'new user-authored content');assert.equal(marker(f).templateVersion,'0.1.1');
 await assert.rejects(upgradeWorkspaceProject(f,input),{code:'TEMPLATE_UPGRADE_CONFLICT'});assert.equal(fs.readFileSync(join(f.projectRoot,'README.md'),'utf8'),'new user-authored content');
});

test('an independent package reads only its pinned template bytes; forged content or manifest fails closed',t=>{
 const f=fixture(t),pkg=join(f.root,'package'),modules=join(pkg,'dist/compat/project');fs.mkdirSync(modules,{recursive:true,mode:0o700});write(join(pkg,'package.json'),{type:'module'});
 for(const file of ['templates.js','files.js'])fs.copyFileSync(join(codeRoot,'dist/compat/project',file),join(modules,file));fs.cpSync(join(codeRoot,'provenance/project-template-v02'),join(pkg,'provenance/project-template-v02'),{recursive:true});
 const script=`import {inspectProjectTemplate} from ${JSON.stringify(pathToFileURL(join(modules,'templates.js')).href)};try{console.log(inspectProjectTemplate().files.length)}catch(e){console.error(e.code);process.exitCode=1}`;
 const run=()=>spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:5000});let child=run();assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'6');
 write(join(pkg,'provenance/project-template-v02/README.md'),'forged');child=run();assert.equal(child.status,1);assert.match(child.stderr,/TEMPLATE_INCOMPLETE/);
 write(join(pkg,'provenance/project-template-v02/manifest.json'),{files:{'README.md':'a'.repeat(64)}});child=run();assert.equal(child.status,1);assert.match(child.stderr,/TEMPLATE_INCOMPLETE/);
});
