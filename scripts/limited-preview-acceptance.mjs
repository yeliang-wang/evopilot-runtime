#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { openBrowser } from '../tests/acceptance/v090/browser.mjs';

const runCommand = promisify(execFile);
const repo = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const version = '0.9.0';
const readOps = [
  'runtime.status', 'runtime.projects.list', 'runtime.events.read', 'runtime.receipt.read',
  'lifecycle.base.inspect', 'lifecycle.definition.inspect', 'lifecycle.definition.read',
  'lifecycle.definition.source.read', 'lifecycle.definition.validate',
];
const writeOps = ['lifecycle.draft.save'];
const caseIds = ['LP01', 'LP02', 'LP03', 'LP04', 'LP05', 'LP06'];
const phase = 'INSTALLED_ISOLATED';
const usage = 'node scripts/limited-preview-acceptance.mjs <pinned-selection.json> <new-private-output-dir>';
function exact(value, keys) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
function canonicalPath(path) {
  assert(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && realpathSync(path) === path);
  return path;
}
function bytes(path, max, privatelyHeld = false) {
  canonicalPath(path);
  const stat = lstatSync(path);
  assert(stat.isFile() && stat.nlink === 1 && stat.size <= max);
  assert((stat.mode & (privatelyHeld ? 0o077 : 0o022)) === 0, 'Unsafe selected file permissions');
  return readFileSync(path);
}
function verify(path, expected, max, privatelyHeld = false) {
  assert.match(expected, /^[a-f0-9]{64}$/);
  const value = bytes(path, max, privatelyHeld);
  assert.equal(hash(value), expected, 'Selected bytes changed at ' + basename(path));
  return value;
}
function privateWrite(path, value) {
  writeFileSync(path, value, {flag:'wx',mode:0o600});
}
function parse(bytes) {
  return JSON.parse(bytes.toString());
}
async function responseText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      assert(length<=262144,'Original service response exceeded the evidence limit');
      chunks.push(part.value);
    }
    return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,length));
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
}
async function runLocal(executable, args, timeout = 15000) {
  // Do not propagate a CLI exception that includes unfiltered command output.
  try {
    const result = await runCommand(executable, args, {encoding:'utf8', timeout, maxBuffer:2*1024*1024});
    return {...result, exitCode:0};
  } catch (error) {
    return {stdout:error.stdout??'',stderr:error.stderr??'',exitCode:Number.isInteger(error.code)?error.code:null};
  }
}
async function localPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
function ownedYaml(base, projectId, yaml) {
  const data = {};
  for (const field of base.fields) {
    if (!field.providers.includes('github')) continue;
    const rules = field.rules;
    let value = rules.fixed;
    if (value === undefined) {
      const values = {
        string:'limited-preview', slug:'limited-preview', version:'1.0.0',
        digest:'sha256:'+hash(field.path), bindingRef:'binding:preview/'+field.id.toLowerCase(),
        credentialRef:'credential:preview/'+field.id.toLowerCase(), repositoryPath:'.github/workflows/preview.yml',
        httpsOrigin:'https://github.com', enum:rules.values?.[0], integer:rules.minimum,
        stringList:rules.contains??rules.values?.slice(0,1), bindingList:['binding:preview/'+field.id.toLowerCase()],
        pathList:['README.md'],
      };
      assert(Object.hasOwn(values,field.type) && values[field.type] !== undefined, 'Unsupported Publisher Base field');
      value = values[field.type];
    }
    const path = field.path.split('.');
    let object = data;
    for (const part of path.slice(0,-1)) object = object[part] ??= {};
    object[path.at(-1)] = value;
  }
  data.extends = {...base.pin};
  data.projectId = projectId;
  data.config.implementation.provider = 'github';
  data.config.publication.channel = 'github-release';
  for (const owner of ['ontology','harness']) data.assets[owner].projectId = projectId;
  return '# Isolated limited Preview draft, with unbound illustrative references\n'+yaml.stringify(data,{lineWidth:0});
}
const sortedUnique = values => [...new Set(values)].sort();

async function checkDistribution(selection, output, retain) {
  const dist = selection.distribution;
  exact(dist, ['packageRoot','manifestRef','manifestDigest','archiveRef','archiveDigest']);
  assert.equal(basename(dist.manifestRef),'distribution-manifest.json');
  assert.equal(basename(dist.archiveRef),'evopilot-runtime-0.9.0-darwin-arm64.tar.gz');
  assert.equal(dirname(dist.manifestRef),dirname(dist.archiveRef));
  const dir = dirname(dist.archiveRef);
  const expectedNames = [
    'distribution-manifest.json', 'evopilot-next-runtime-0.9.0.tgz',
    basename(dist.archiveRef),'runtime-dependency-lock.json','source-revision.txt',
  ].sort();
  const checksum = bytes(join(dir,'SHA256SUMS'),4096);
  const lines = checksum.toString().trimEnd().split('\n');
  const pins = {};
  for (const line of lines) {
    const entry = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    assert(entry && expectedNames.includes(entry[2]) && !Object.hasOwn(pins,entry[2]),'Unsafe checksum inventory');
    pins[entry[2]] = entry[1];
  }
  assert.deepEqual(Object.keys(pins).sort(),expectedNames);
  assert.equal(pins[basename(dist.archiveRef)],dist.archiveDigest);
  assert.equal(pins[basename(dist.manifestRef)],dist.manifestDigest);
  for (const name of expectedNames) verify(join(dir,name),pins[name],268435456);
  assert.equal(bytes(join(dir,'source-revision.txt'),128).toString(),selection.sourceCommit+'\n');
  const manifest = parse(bytes(dist.manifestRef,8388608,true));
  exact(manifest,['schema','version','archiveDigest','files']);
  assert.equal(manifest.schema,'runtime-standalone-distribution/v1');
  assert.equal(manifest.archiveDigest,dist.archiveDigest);
  assert.equal(manifest.version,version);

  // The deterministic packer validates every local file and link, then proves
  // the reviewed archive is its exact safe USTAR encoding before extraction.
  const {packStandaloneTree} = await import('../dist/installation/distribution.js');
  const fromSelected = packStandaloneTree(canonicalPath(dist.packageRoot));
  assert.deepEqual(fromSelected.files,manifest.files);
  assert.equal(hash(fromSelected.archive),dist.archiveDigest);
  const extraction = join(output,'from-exact-archive');
  mkdirSync(extraction,{mode:0o700});
  const expanded = await runLocal('/usr/bin/tar',['-xzpf',dist.archiveRef,'-C',extraction],60000);
  assert.equal(expanded.exitCode,0,'Exact local archive extraction failed');
  const packageRoot = join(extraction,'package');
  const fromArchive = packStandaloneTree(packageRoot);
  assert.deepEqual(fromArchive.files,manifest.files);
  assert.equal(hash(fromArchive.archive),dist.archiveDigest);
  const metadata = parse(bytes(join(packageRoot,'package.json'),1048576));
  assert.equal(metadata.name,'@evopilot-next/runtime');
  assert.equal(metadata.version,version);
  assert.equal(metadata.evopilotDistributionProfile,'limited-preview');
  assert(!Object.hasOwn(metadata.bin,'evopilot-next-runtime'));
  assert(!existsSync(join(packageRoot,'dist/cli.js')));
  retain('LP01','distribution.json',{
    selection, mode:metadata.evopilotDistributionProfile, checksum:checksum.toString(), checksumSha256:hash(checksum),
    distributionFiles:Object.keys(manifest.files).length, observedArchiveSha256:hash(fromArchive.archive),
    exactArchiveExtraction:true, verifiedReleaseSource:selection.sourceCommit,
  });
  return {...dist,packageRoot};
}
function select() {
  assert.equal(process.argv.length,4,usage);
  assert.equal(process.platform+'-'+process.arch,'darwin-arm64');
  assert.equal(process.version,'v24.14.0');
  const selectionRef = canonicalPath(process.argv[2]);
  const selectionBytes = bytes(selectionRef,1048576,true);
  const selection = parse(selectionBytes);
  exact(selection,['schema','sourceCommit','distribution','nodeExecutable','nodeSha256','browserExecutable','browserSha256']);
  assert.equal(selection.schema,'runtime-limited-preview-acceptance-selection/v1');
  assert.match(selection.sourceCommit,/^[a-f0-9]{40}$/);
  exact(selection.distribution,['packageRoot','manifestRef','manifestDigest','archiveRef','archiveDigest']);
  for (const field of ['archiveDigest','manifestDigest']) assert.match(selection.distribution[field],/^[a-f0-9]{64}$/);
  assert.equal(canonicalPath(selection.nodeExecutable),realpathSync(process.execPath));
  verify(selection.nodeExecutable,selection.nodeSha256,268435456);
  verify(selection.browserExecutable,selection.browserSha256,536870912);
  const output = process.argv[3];
  assert(isAbsolute(output) && resolve(output)===output && !existsSync(output));
  const parent = lstatSync(canonicalPath(dirname(output)));
  assert(parent.isDirectory() && parent.uid===process.getuid() && (parent.mode&0o077)===0,
    'Select a new output directory in an owned private parent');
  assert(!(output.startsWith(repo+sep) || repo.startsWith(output+sep)), 'Evidence must be outside the source worktree');
  mkdirSync(output,{mode:0o700});
  return {selection,selectionSha256:hash(selectionBytes),output};
}
function caseResult(cases, id) {
  const item = cases.get(id);
  assert.equal(item.outcome,'PENDING');
  assert(item.artifacts.length>0);
  item.outcome = 'PASS';
}
async function smoke({selection,selectionSha256,output}) {
  const startedAt = new Date().toISOString();
  const cases = new Map(caseIds.map(id=>[id,{id,outcome:'PENDING',artifacts:[]}]));
  let native, plan, browser, editor, monitor, ownedServiceActive = false, failure;
  const sensitive = [];
  const retain = (id,name,value) => {
    const entry = cases.get(id);
    assert(entry && /^[a-z0-9-]+\.(?:json|png)$/.test(name));
    const original = Buffer.isBuffer(value) ? value : Buffer.from(json(value));
    assert(original.length<=12*1024*1024);
    for (const secret of sensitive) assert(!original.includes(secret),'Credential in evidence output');
    const ref = id.toLowerCase()+'-'+name;
    privateWrite(join(output,ref),original);
    const pin = {ref,sha256:hash(original),bytes:original.length};
    entry.artifacts.push(pin);
    return pin;
  };
  const redact = value => {
    let result = String(value);
    for (const secret of sensitive) result = result.replaceAll(secret,'[redacted]');
    return result.slice(0,4096);
  };
  const importFrom = (root,path) => import(pathToFileURL(join(root,path)).href);
  try {
    const git = await runLocal('/usr/bin/git',['-C',repo,'rev-parse','HEAD']);
    assert.equal(git.exitCode,0);
    assert.equal(git.stdout.trim(),selection.sourceCommit);
    const clean = await runLocal('/usr/bin/git',['-C',repo,'status','--porcelain']);
    assert.equal(clean.exitCode,0);
    assert.equal(clean.stdout,'','Use a clean source checkout at the selected candidate');
    const distribution = await checkDistribution(selection,output,retain);
    caseResult(cases,'LP01');

    native = await importFrom(distribution.packageRoot,'dist/installation/installer.js');
    const id = 'lp-'+randomUUID().slice(0,8);
    const root = join(output,'installation');
    const packageRoot = join(root,'package');
    const projectId = id, workspaceId = id, principalId = 'preview-editor', port = await localPort();
    const serviceOrigin = 'http://127.0.0.1:'+port;
    plan = {
      schema:'runtime-install-plan/v1',root,distribution,nodeExecutable:selection.nodeExecutable,
      nodeSha256:selection.nodeSha256,workspaceId,projectId,principalId,role:'editor',port,
      credentialExpiresAt:new Date(Date.now()+60*60*1000).toISOString(),integrationsRef:null,codex:null,
    };
    retain('LP02','install-plan.json',plan);
    const stage = await native.runInstaller(plan,'stage');
    retain('LP02','native-stage.json',stage);
    assert.equal(stage.phase,'STAGED');
    assert.equal(stage.hostRegistered,false);
    const beforeStart = await native.runInstaller(plan,'inspect');
    retain('LP02','native-before-start.json',beforeStart);
    assert.equal(beforeStart.service.running,false);
    assert.equal(beforeStart.service.registered,false);
    const boot = await native.runInstaller(plan,'start');
    ownedServiceActive = true;
    retain('LP02','native-start.json',boot);
    assert.equal(boot.hostRegistered,null);
    assert.equal(boot.hostVerification,'NOT_EVALUATED');
    assert.equal(boot.service.running,true);
    assert.equal(boot.service.registered,true);
    assert(Number.isSafeInteger(boot.service.pid) && boot.service.pid > 0);
    const serviceId = boot.service.identity.serviceId;
    assert.equal(boot.service.identity.version,version);

    const connectionRef = join(root,'connection.json');
    const security = await importFrom(packageRoot,'dist/server/security.js');
    const connection = security.readHostConnection(connectionRef);
    assert.equal(connection.serviceId,serviceId);
    assert.equal(connection.origin,serviceOrigin);
    const auth = security.hostHeaders(connection).Authorization;
    sensitive.push(auth.slice(7));
    const cliPath = join(packageRoot,'dist/server/cli.js');
    const installerPath = join(packageRoot,'dist/installation/installer.js');
    const cli = (...args) => runLocal(selection.nodeExecutable,[cliPath,...args]);
    const serviceFlags = ['--url',serviceOrigin,'--token-ref',connection.tokenRef,'--project',projectId];
    async function raw(id,name,path,{body,method='POST',headers={},credential=true}={}) {
      assert(path.startsWith('/') && !path.startsWith('//'));
      const response = await fetch(serviceOrigin+path,{
        method, headers:{...(credential?{authorization:auth}:{}),'content-type':'application/json',...headers},
        ...(body===undefined?{}:{body:JSON.stringify(body)}), redirect:'error',signal:AbortSignal.timeout(12000),
      });
      const original = await responseText(response);
      const safeHeaders = Object.fromEntries(['content-type','x-request-id','mcp-protocol-version'].flatMap(
        key=>response.headers.has(key)?[[key,response.headers.get(key)]]:[]));
      retain(id,name+'.json',{request:{method,path,body:body??null,authenticated:credential},
        status:response.status,headers:safeHeaders,rawBody:original,observedAt:new Date().toISOString()});
      return {status:response.status,headers:safeHeaders,body:original?JSON.parse(original):null};
    }
    async function read(id,name,operation,input={}) {
      const response = await raw(id,name,'/api/v1/request',{body:{operation,projectId,input}});
      assert.equal(response.status,200);
      assert.equal(response.body.requestId,response.headers['x-request-id']);
      return response.body.result;
    }
    async function readCliStatus(name) {
      const observed = await cli('status',...serviceFlags);
      retain('LP02',name+'.json',observed);
      assert.equal(observed.exitCode,0);
      const status = parse(observed.stdout).result;
      assert.equal(status.version,version);
      assert.equal(status.distributionProfile,'limited-preview');
      assert.equal(status.serviceId,serviceId);
      assert.equal(status.workspaceId,workspaceId);
      assert.equal(status.projectId,projectId);
      assert.equal(status.legacy,null);
      assert.equal(status.observationWorker,null);
      assert.equal(status.usageWorker,null);
      assert.deepEqual([...status.operations].sort(),[...readOps,...writeOps].sort());
      return status;
    }
    const initialStatus = await readCliStatus('cli-status');
    assert.equal(initialStatus.revision,0);

    const yaml = await importFrom(packageRoot,'node_modules/yaml/dist/index.js');
    const base = await read('LP03','base','lifecycle.base.inspect');
    const source = ownedYaml(base,projectId,yaml);
    const initial = await read('LP03','initial','lifecycle.definition.inspect');
    assert.equal(initial.active,null);
    assert.equal(initial.draft,null);
    const compilation = await read('LP03','valid-input','lifecycle.definition.validate',{yaml:source});
    assert.equal(compilation.compilation.valid,true);
    assert.equal(compilation.ready,false,'No live provider or owner bindings are admitted');
    assert.equal(compilation.validationDigest,null);
    for (const [name,invalid] of [
      ['invalid-syntax','config: {'],
      ['invalid-base',source.replace(base.pin.digest,'sha256:'+'0'.repeat(64))],
    ]) {
      assert.notEqual(invalid,source);
      const invalidResult = await read('LP03',name,'lifecycle.definition.validate',{yaml:invalid});
      assert.equal(invalidResult.compilation.valid,false);
      assert.equal(invalidResult.ready,false);
      assert(invalidResult.issues.some(issue=>issue.code&&issue.path&&issue.rule));
    }
    browser = await chromium.launch({headless:true,executablePath:selection.browserExecutable,
      args:['--disable-background-networking','--disable-sync','--no-proxy-server']});
    const browserAccess = {
      version:()=>browser.version(),
      async newContext(settings) {
        const context = await browser.newContext(settings);
        await context.route('**/*',route=>new URL(route.request().url()).origin===serviceOrigin
          ? route.continue() : route.abort('blockedbyclient'));
        return context;
      },
    };
    function browserRun(caseId, prefix) {
      let imageIndex = 0, artifactIndex = 0;
      return {
        candidate:{serviceId,manifestDigest:distribution.manifestDigest},
        selection:{installedRoot:root,workspaceId,browserConfiguration:{allowServiceRestart:false}},
        principal:()=>({projectId,principalId,expectedPermissions:['read','draft.write']}),
        serviceOrigin,
        async browserCode() {
          const code = await cli('browser-code','--connection-ref',connectionRef);
          assert.equal(code.exitCode,0,'One-use browser connection failed');
          const value = parse(code.stdout);
          assert.equal(value.oneUse,true);
          assert.equal(value.projectId,projectId);
          assert.match(value.code,/^[A-Za-z0-9_-]{43}$/);
          sensitive.push(value.code);
          return value.code;
        },
        artifact:(name,value)=>retain(caseId,prefix+'-'+String(++artifactIndex)+'-'+name,value),
        imageArtifact:data=>retain(caseId,prefix+'-'+String(++imageIndex)+'.png',data),
      };
    }
    monitor = await openBrowser(browserRun('LP04','monitor'),browserAccess,{route:'/monitor',monitorEvidence:true});
    const initialMonitor = await monitor.monitor();
    assert.equal(initialMonitor.projectId,projectId);
    assert.equal(initialMonitor.readOnly,true);
    assert.equal(initialMonitor.revision,0);
    assert.deepEqual(initialMonitor.instances,[]);
    await expect(monitor.page.getByRole('heading',{name:'暂无生命周期实例'})).toBeVisible();
    await expect.poll(()=>monitor.sseFrames.some(frame=>frame.eventName==='snapshot')).toBe(true);

    editor = await openBrowser(browserRun('LP03','editor'),browserAccess);
    await expect(editor.source).toBeEditable();
    await expect(editor.source).toHaveValue('');
    await editor.validateEdit('yaml',source,()=>editor.source.fill(source));
    await editor.valid();
    await expect(editor.node('scope')).toBeVisible();
    await expect(editor.page.locator('svg .n-box').first()).toBeVisible();
    const beforeGraph = yaml.parse(source);
    const {updated,graphPreview} = await editor.step('Edit graph layout and validate the exact resulting YAML',async()=>{
      const start = editor.network.length;
      await editor.node('scope').focus();
      await editor.page.keyboard.press('ArrowDown');
      await expect.poll(async()=>yaml.parse(await editor.source.inputValue()).presentation?.layout?.scope?.y).toBe(90);
      const updated = await editor.source.inputValue();
      await editor.preview();
      const response = editor.network.slice(start).findLast(row=>
        row.request?.operation==='lifecycle.definition.validate' && row.request.input.yaml===updated &&
        row.status===200 && row.transportOutcome==='RESPONSE_RETAINED');
      assert(response,'Retain the browser validation of the exact graph-edited YAML');
      const graphPreview = JSON.parse(response.rawBody);
      return {updated,graphPreview};
    });
    assert(updated.startsWith('# Isolated limited Preview draft'));
    const afterGraph = yaml.parse(updated);
    delete afterGraph.presentation;
    assert.deepEqual(afterGraph,beforeGraph);
    assert.equal(graphPreview.result.compilation.valid,true);
    assert.equal(graphPreview.result.compilation.effective.semanticDigest,compilation.compilation.effective.semanticDigest);
    assert.equal(graphPreview.result.ready,false);
    await expect(editor.page.getByRole('button',{name:'保存并启用',exact:true})).toHaveCount(0);
    await editor.save();
    const result = await read('LP03','saved','lifecycle.definition.inspect');
    assert.equal(result.active,null);
    assert(result.draft?.id);
    assert.equal(result.revision,initial.revision+1);
    async function checkSource(id,name) {
      const original = await read(id,name,'lifecycle.definition.source.read',{revisionId:result.draft.id});
      assert.equal(original.encoding,'base64');
      assert.equal(original.nextOffset,null);
      assert.equal(Buffer.from(original.data,'base64').toString(),updated);
      assert.equal(original.sourceDigest,'sha256:'+hash(updated));
    }
    await checkSource('LP03','saved-yaml');
    const save = editor.network.filter(row=>row.request?.operation==='lifecycle.draft.save');
    assert.equal(save.length,1);
    const originalSave = JSON.parse(save[0].rawBody);
    assert.equal(originalSave.result.result.status,'DRAFT');
    assert.equal(originalSave.result.result.revisionId,result.draft.id);
    assert.equal(originalSave.result.result.activeRevisionId,null);
    assert.equal(originalSave.result.result.executionAuthorized,false);
    assert.equal(originalSave.result.result.releaseAuthorized,false);
    const receipt = await read('LP03','saved-receipt','runtime.receipt.read',{requestId:save[0].request.requestId});
    assert.equal(receipt.result.revisionId,result.draft.id);

    await expect.poll(()=>monitor.sseFrames.some(frame=>frame.eventName==='events'&&
      JSON.parse(frame.data).events?.some(event=>event.type==='definition-draft-saved' && event.revision===result.revision)),
      {timeout:10000}).toBe(true);
    const readOnly = await monitor.monitor();
    assert.equal(readOnly.projectId,projectId);
    assert.equal(readOnly.revision,result.revision);
    assert.equal(readOnly.readOnly,true);
    assert.deepEqual(readOnly.instances,[]);
    for (const frame of monitor.sseFrames) {
      assert(['snapshot','events','heartbeat'].includes(frame.eventName));
      const value = JSON.parse(frame.data);
      assert.equal(value.projectId,projectId);
      assert.equal(typeof value.cursor,'string');
      assert(Number.isSafeInteger(value.watermark.sequence)&&Number.isSafeInteger(value.watermark.revision));
      for (const event of value.events) exact(event,['seq','revision','type','at']);
    }
    await expect(monitor.source).toHaveCount(0);
    await expect(monitor.page.getByRole('button',{name:/保存|启用|执行|重试|发布/})).toHaveCount(0);
    await monitor.flush();
    assert.deepEqual(monitor.network,[],'Monitor emitted a dashboard mutation/read envelope');
    await monitor.close();
    monitor = undefined;
    retain('LP04','monitor-summary.json',{initial:initialMonitor,after:readOnly,instanceSeeded:false,businessExecution:false});
    caseResult(cases,'LP04');

    const prohibited = [
      ['lifecycle.definition.activate',{revisionId:result.draft.id,validationDigest:'sha256:'+hash(updated)}],
      ['lifecycle.definition.save-and-activate',{yaml:updated,validationDigest:'sha256:'+hash(updated)}],
      ['lifecycle.instance.create',{instanceId:'isolated-preview-denied',definitionRevisionId:result.draft.id,authorityRef:'isolated-preview-denied'}],
      ['lifecycle.stage.request',{instanceId:'isolated-preview-denied',stageId:'implementation'}],
      ['lifecycle.stage.request',{instanceId:'isolated-preview-denied',stageId:'verification'}],
      ['lifecycle.stage.request',{instanceId:'isolated-preview-denied',stageId:'publication'}],
      ['lifecycle.stage.reconcile',{stageRequestId:'isolated-preview-denied'}],
      ['lifecycle.stage.advance',{stageRequestId:'isolated-preview-denied'}],
      ['lifecycle.authority.record',{kind:'release',subject:{},reviewDigest:'sha256:'+hash(updated),decision:'APPROVE',evidenceRef:'isolated-preview-denied'}],
      ['lifecycle.agent.claim',{stageRequestId:'isolated-preview-denied',handoffDigest:'sha256:'+hash(updated),host:{}}],
      ['lifecycle.qualification.dispatch',{}],
      ['runtime.legacy.write',{}],
      ['usage.source.register',{}],
    ];
    async function mcp(name, method, params, initialize = false) {
      const id = randomUUID();
      const response = await raw('LP05',name,'/mcp',{
        headers:{accept:'application/json, text/event-stream',...(initialize?{}:{'mcp-protocol-version':'2025-11-25'})},
        body:{jsonrpc:'2.0',...(method.startsWith('notifications/')?{}:{id}),method,...(params?{params}:{})},
      });
      if (!method.startsWith('notifications/')) assert.equal(response.body.id,id);
      return response;
    }
    const hello = await mcp('mcp-initialize','initialize',{
      protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'runtime-limited-installed-acceptance',version:'1'},
    },true);
    assert.equal(hello.status,200);
    assert.equal(hello.body.result.protocolVersion,'2025-11-25');
    assert.equal(hello.body.result.serverInfo.version,version);
    assert.equal((await mcp('mcp-ready','notifications/initialized')).status,202);
    const listed = await mcp('mcp-tools','tools/list');
    const tools = listed.body.result.tools;
    assert.deepEqual(tools.map(tool=>tool.name).sort(),['runtime_read','runtime_write']);
    assert.deepEqual(sortedUnique(tools.find(tool=>tool.name==='runtime_read').inputSchema.properties.operation.enum),[...readOps].sort());
    const writeTool = tools.find(tool=>tool.name==='runtime_write');
    assert.deepEqual(writeTool.inputSchema.properties.operation.enum,writeOps);
    assert.doesNotMatch(writeTool.description,/activate|dispatch|publish|release|execute/i);
    const goodMcp = await mcp('mcp-allow-read','tools/call',{name:'runtime_read',arguments:{operation:'runtime.status',projectId,input:{}}});
    assert.equal(goodMcp.status,200);
    assert.notEqual(goodMcp.body.result.isError,true);
    const mcpStatus = JSON.parse(goodMcp.body.result.content[0].text).result;
    assert.equal(mcpStatus.serviceId,serviceId);
    assert.equal(mcpStatus.distributionProfile,'limited-preview');
    for (const [index,[operation,input]] of prohibited.entries()) {
      const envelope = {operation,projectId,input,requestId:randomUUID(),expectedRevision:result.revision};
      const http = await raw('LP05','http-denial-'+index,'/api/v1/request',{body:envelope});
      assert.equal(http.status,403);
      assert.equal(http.body.error.code,'LIMITED_PREVIEW');
      const denied = await mcp('mcp-denial-'+index,'tools/call',{name:'runtime_write',arguments:envelope});
      assert.equal(denied.status,200);
      assert.equal(denied.body.result.isError,true);
      assert.equal(JSON.parse(denied.body.result.content[0].text).error.code,'LIMITED_PREVIEW');
    }
    const blockedRead = {operation:'usage.sources.list',projectId,input:{}};
    const httpRead = await raw('LP05','http-extra-read','/api/v1/request',{body:blockedRead});
    assert.equal(httpRead.status,403);
    assert.equal(httpRead.body.error.code,'LIMITED_PREVIEW');
    const blockedMcpRead = await mcp('mcp-extra-read','tools/call',{name:'runtime_read',arguments:blockedRead});
    assert.equal(blockedMcpRead.body.result.isError,true);
    assert.equal(JSON.parse(blockedMcpRead.body.result.content[0].text).error.code,'LIMITED_PREVIEW');
    const unauthed = await raw('LP05','http-unauthenticated','/api/v1/status?projectId='+projectId,{method:'GET',credential:false});
    assert.equal(unauthed.status,401);
    const crossProject = await raw('LP05','http-cross-project','/api/v1/status?projectId=another-project',{method:'GET'});
    assert.equal(crossProject.status,403);
    const [activate,activateInput] = prohibited[1];
    const browserDenial = await editor.sessionRequest(activate,activateInput,{requestId:randomUUID(),expectedRevision:result.revision});
    assert.equal(browserDenial.status,403);
    assert.equal(browserDenial.body.error.code,'LIMITED_PREVIEW');
    const browserExecution = await editor.sessionRequest('lifecycle.stage.request',prohibited[3][1],
      {requestId:randomUUID(),expectedRevision:result.revision});
    assert.equal(browserExecution.status,403);
    assert(['DASHBOARD_OPERATION','LIMITED_PREVIEW'].includes(browserExecution.body.error.code));

    const deniedEnvelope = join(output,'cli-request.json');
    privateWrite(deniedEnvelope,json({operation:'lifecycle.stage.request',projectId,input:prohibited[3][1],
      requestId:randomUUID(),expectedRevision:result.revision}));
    const cmdDenied = await cli('request',...serviceFlags,'--request-ref',deniedEnvelope);
    retain('LP05','cli-execution-denial.json',cmdDenied);
    assert.equal(cmdDenied.exitCode,1);
    assert.equal(parse(cmdDenied.stdout).error.code,'LIMITED_PREVIEW');
    for (const role of ['activator','operator']) {
      const blockedRoot = join(output,'blocked-'+role);
      await assert.rejects(native.runInstaller({...plan,role,root:blockedRoot},'stage'),{code:'LIMITED_PREVIEW'});
      assert(!existsSync(blockedRoot));
      const bootstrap = await cli('auth-init','--state-root',blockedRoot,'--workspace-id',workspaceId,
        '--project',projectId,'--principal','preview-blocked','--role',role);
      retain('LP05','rejected-'+role+'.json',{installerCode:'LIMITED_PREVIEW',bootstrap,noStateCreated:!existsSync(blockedRoot)});
      assert.equal(bootstrap.exitCode,1);
      assert.equal(parse(bootstrap.stdout).error.code,'LIMITED_PREVIEW');
      assert(!existsSync(blockedRoot));
    }
    const rejectedConfig = join(output,'blocked-integrations.json');
    privateWrite(rejectedConfig,'{}\n');
    const serve = await cli('serve','--state-root',join(output,'blocked-serve'),'--workspace-id',workspaceId,'--integrations-ref',rejectedConfig);
    retain('LP05','cli-provider-denial.json',serve);
    assert.equal(serve.exitCode,1);
    assert.equal(parse(serve.stdout).error.code,'LIMITED_PREVIEW');
    const upgrade = await runLocal(selection.nodeExecutable,[installerPath,'service-upgrade']);
    retain('LP05','cli-upgrade-denial.json',upgrade);
    assert.equal(upgrade.exitCode,1);
    assert.equal(parse(upgrade.stdout).error.code,'LIMITED_PREVIEW');
    const latest = await read('LP05','unchanged-after-denials','lifecycle.definition.inspect');
    assert.deepEqual(latest,result);
    const events = await read('LP05','events-after-denials','runtime.events.read');
    assert.deepEqual(events.events.map(event=>event.type),['definition-draft-saved']);
    await editor.flush();
    await editor.close();
    editor = undefined;
    caseResult(cases,'LP03');
    caseResult(cases,'LP05');

    const stop = await native.runInstaller(plan,'stop');
    ownedServiceActive = false;
    retain('LP02','native-stop.json',stop);
    assert.equal(stop.phase,'STOPPED');
    assert.equal(stop.service.running,false);
    assert.equal(stop.service.registered,false);
    const restart = await native.runInstaller(plan,'start');
    ownedServiceActive = true;
    retain('LP02','native-restart.json',restart);
    assert.equal(restart.service.running,true);
    assert.equal(restart.service.identity.serviceId,serviceId);
    const restartedStatus = await readCliStatus('cli-restarted-status');
    assert.equal(restartedStatus.revision,result.revision);
    await checkSource('LP02','restarted-yaml');
    const restarted = await openBrowser(browserRun('LP02','restarted-editor'),browserAccess);
    try { await expect(restarted.source).toHaveValue(updated); await restarted.valid(); }
    finally { await restarted.close(); }

    const plugin = parse(bytes(join(root,'plugin','.codex-plugin/plugin.json'),1048576,true));
    const mcpFile = parse(bytes(join(root,'plugin','.mcp.json'),1048576,true));
    const pluginPackage = parse(bytes(join(packageRoot,'plugins/codex/.codex-plugin/plugin.json'),1048576));
    assert.deepEqual(plugin,pluginPackage);
    assert.equal(plugin.name,'evopilot-runtime');
    assert.equal(plugin.version,version);
    assert.equal(plugin.mcpServers,'./.mcp.json');
    assert.match(plugin.description,/limited|draft/i);
    assert.doesNotMatch(plugin.description,/governed execution|provider|publish/i);
    exact(mcpFile,['mcpServers']);
    exact(mcpFile.mcpServers,['evopilot_runtime']);
    const service = mcpFile.mcpServers.evopilot_runtime;
    exact(service,['type','url','http_headers_helper']);
    assert.equal(service.type,'http');
    assert.equal(service.url,serviceOrigin+'/mcp');
    assert(service.http_headers_helper.includes(connectionRef));
    const help = await cli('help');
    assert.equal(help.exitCode,0);
    const commands = parse(help.stdout).commands;
    assert.deepEqual([...commands].sort(),['auth-init','browser-code','request','serve','status']);
    const english = bytes(join(packageRoot,'README.md'),1048576).toString();
    const chinese = bytes(join(packageRoot,'README_CN.md'),1048576).toString();
    assert.match(english,/limited.{0,30}preview/is);
    assert.match(chinese,/限定.{0,24}(?:Preview|预览)/is);
    for (const doc of [english,chinese]) {
      assert(doc.includes('/releases/tag/v0.9.0'));
      assert(doc.includes('SHA256SUMS'));
      assert(doc.includes('/lifecycle') && doc.includes('/monitor'));
    }
    retain('LP06','plugin-docs.json',{
      plugin,mcp:mcpFile,hostRegistered:false,help,documentation:[
        {path:'README.md',sha256:hash(english),bytes:Buffer.byteLength(english)},
        {path:'README_CN.md',sha256:hash(chinese),bytes:Buffer.byteLength(chinese)},
      ],
    });
    caseResult(cases,'LP06');
  } catch (error) {
    const stack = String(error?.stack??'').split('\n').find(line=>line.includes('limited-preview-acceptance.mjs:'));
    failure = redact([error?.message??error,stack].filter(Boolean).join('\n'));
  } finally {
    for (const page of [editor,monitor]) {
      if (!page) continue;
      try { await page.close(); } catch (error) { failure??=redact(error.message); }
    }
    if (browser) {
      try { await browser.close(); } catch (error) { failure??=redact(error.message); }
    }
    if (native&&plan&&(ownedServiceActive||existsSync(join(plan.root,'service-specification.json')))) {
      try {
        const stop = await native.runInstaller(plan,'stop');
        retain('LP02','native-final-stop.json',stop);
        assert.equal(stop.phase,'STOPPED');
        assert.equal(stop.service.running,false);
        assert.equal(stop.service.registered,false);
      } catch (error) { failure??=redact(error.message); }
    }
    if (!failure) caseResult(cases,'LP02');
    const complete = [...cases.values()].every(item=>item.outcome==='PASS');
    const result = {
      schema:'runtime-limited-preview-acceptance/v1',mode:'limited-preview',phase,
      tag:'v0.9.0',platform:'darwin-arm64',status:!failure&&complete?'PASSED':'FAILED',
      sourceCommit:selection.sourceCommit,archiveDigest:selection.distribution.archiveDigest,
      manifestDigest:selection.distribution.manifestDigest,selectionSha256,
      operations:{read:readOps,write:writeOps},cases:[...cases.values()],
      startedAt,completedAt:new Date().toISOString(),failure:failure??null,
      signed:false,hostRegistered:false,fullAcceptance:'NOT_EVALUATED',releaseAuthorized:false,
    };
    privateWrite(join(output,'RESULT.json'),json(result));
    console.log(json({status:result.status,result:join(output,'RESULT.json')}).trimEnd());
    if (result.status!=='PASSED') process.exitCode=1;
  }
}

if (process.argv.length===3 && process.argv[2]==='--help') console.log(usage);
else {
  try { await smoke(select()); }
  catch (error) { console.error(String(error.message).slice(0,4096)); process.exitCode=1; }
}
