import {test,expect} from '@playwright/test';
import {dashboardFixture} from '../fixtures/dashboard-v090-worker.mjs';
import {extension,yaml} from '../fixtures/lifecycle-v090.mjs';
import {parse} from 'yaml';
let f;
test.beforeEach(async()=>{f=await dashboardFixture();});
test.afterEach(async()=>{await f?.close();});
async function login(page,route='/lifecycle',actor='owner'){
 await page.goto(f.url+route);await page.getByLabel('一次性连接码').fill(await f.code(actor));await page.getByRole('button',{name:'连接项目',exact:true}).click();
 await expect(page.getByRole('heading',{name:route==='/lifecycle'?'生命周期定义':'生命周期监控',exact:true})).toBeVisible();
}
const source=page=>page.getByLabel('Project Lifecycle YAML');
const node=(page,id)=>page.locator('[data-sc-node="'+id+'"]');
async function valid(page){await expect(page.getByText('图形已与当前源码结构核对',{exact:false})).toBeVisible();}
async function save(page){await page.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page.getByText('草稿已保存。',{exact:true})).toBeVisible();await expect(source(page)).toBeEditable();}

test('actual SeeCode graph, field/keyboard/drag edits and YAML comments persist through save and service restart',async({page},info)=>{
 const faults=[],external=[];page.on('pageerror',e=>faults.push(e.message));page.on('request',r=>{if(!r.url().startsWith(f.url))external.push(r.url());});
 await login(page);await valid(page);await expect(node(page,'scope')).toBeVisible();await expect(page.locator('svg [data-sc-node]')).toHaveCount(8);
 expect(await page.locator('svg').innerHTML()).toContain('n-box');
 await node(page,'scope').focus();await page.keyboard.press('ArrowDown');await expect.poll(async()=>parse(await source(page).inputValue()).presentation?.layout?.scope?.y).toBe(90);
 const base=await f.call('lifecycle.base.inspect'),bindingField=base.fields.find(v=>v.stage==='scope'&&v.type==='bindingRef');const field=page.locator('#field-'+bindingField.id);await field.fill('binding:browser/changed');await field.press('Enter');await expect(source(page)).toContainText('binding:browser/changed');
 await node(page,'scope').scrollIntoViewIfNeeded();const box=await node(page,'scope').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+55,box.y+box.height/2);await page.mouse.up();await expect.poll(async()=>parse(await source(page).inputValue()).presentation.layout.scope.x).toBe(200);
 const changed=await source(page).inputValue();expect(changed).toContain('# Browser development fixture');await save(page);const view=await f.call('lifecycle.definition.inspect');expect(await f.source(view.draft.id)).toBe(changed);expect(view.active).toBeNull();
 await page.screenshot({path:info.outputPath('editor-desktop.png'),fullPage:true});await f.restart();await page.reload();await page.getByLabel('一次性连接码').fill(await f.code());await page.getByRole('button',{name:'连接项目',exact:true}).click();await expect(source(page)).toHaveValue(changed);
 expect(external).toEqual([]);expect(faults).toEqual([]);
});

test('same-page exact validation/diff activation preserves old active on stale bindings and retains concurrent edits',async({page})=>{
 await login(page);await valid(page);await page.getByRole('button',{name:'校验与差异预览'}).click();await expect(page.getByRole('heading',{name:'与当前生效版本的准确差异'})).toBeVisible();await expect(page.getByRole('button',{name:'保存并启用'})).toBeEnabled();await page.getByRole('button',{name:'保存并启用'}).click();await expect(page.getByText('已启用此精确定义。既有实例继续使用原版本。')).toBeVisible();await expect(source(page)).toBeEditable();
 const active=(await f.call('lifecycle.definition.inspect')).active.id;
 await source(page).fill(f.initialSource+'\n# blocked binding');await page.getByRole('button',{name:'校验与差异预览'}).click();await expect(page.getByRole('button',{name:'保存并启用'})).toBeEnabled();f.bindings.state.revision='changed-after-preview';await page.getByRole('button',{name:'保存并启用'}).click();await expect(page.getByText('启用被门禁阻止，草稿已保留，原生效版本未变。')).toBeVisible();expect((await f.call('lifecycle.definition.inspect')).active.id).toBe(active);
 await expect(source(page)).toBeEditable();const local=f.initialSource+'\n# unsaved local';await source(page).fill(local);await f.write('lifecycle.draft.save',{yaml:f.initialSource+'\n# concurrent agent'});await page.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page.getByRole('button',{name:'重新读取',exact:true})).toBeVisible();await expect(source(page)).toHaveValue(local);await expect(page.getByRole('button',{name:'保存草稿',exact:true})).toBeDisabled();
});

test('incomplete extension stays editable; both source and graph form changes preserve required AND dependencies',async({page})=>{
 await login(page);await valid(page);await page.getByText('添加项目扩展',{exact:true}).click();await page.getByLabel('扩展标识',{exact:true}).fill('project.review');await page.getByRole('button',{name:'加入草稿'}).click();await expect(node(page,'project.review')).toBeVisible();await node(page,'project.review').click();await expect(page.getByLabel('扩展属性（JSON）')).toBeVisible();await page.getByLabel('扩展属性（JSON）').fill(JSON.stringify(extension('review')));await page.getByRole('button',{name:'应用扩展属性'}).click();await valid(page);
 const value=parse(await source(page).inputValue());value.extensions.push(extension('security'));await source(page).fill(yaml(value));await valid(page);await node(page,'project.security').click();await page.getByLabel('同槽位前置节点').selectOption('project.review');await page.getByRole('button',{name:'添加依赖',exact:true}).click();await expect.poll(async()=>parse(await source(page).inputValue()).extensions[1].dependsOn).toEqual(['project.review']);await valid(page);
 await node(page,'project.review').click();await page.getByLabel('同槽位前置节点').selectOption('project.security');await page.getByRole('button',{name:'添加依赖',exact:true}).click();await expect(page.getByText('该连线会产生循环。',{exact:true})).toBeVisible();expect(parse(await source(page).inputValue()).extensions[0].dependsOn).toEqual([]);
 await save(page);await node(page,'scope').click();await expect(page.locator('.properties input:disabled').first()).toBeVisible();
});

test('lost committed response is inspected by original request and never automatically re-submitted',async({page})=>{
 await login(page);await valid(page);const text=f.initialSource+'\n# exact lost response';await source(page).fill(text);let writes=0,original;
 await page.route('**/api/v1/dashboard/request',async route=>{const payload=route.request().postDataJSON();if(payload.operation==='lifecycle.draft.save'){writes++;original=payload.requestId;const r=await route.fetch();expect(r.status()).toBe(200);await route.abort('connectionreset');}else await route.continue();});
 await page.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page.getByRole('button',{name:'核对原请求'})).toBeEnabled();await expect(page.getByRole('button',{name:'保存草稿',exact:true})).toBeDisabled();await page.getByRole('button',{name:'核对原请求'}).click();await expect(page.getByRole('button',{name:'重新读取',exact:true})).toBeVisible();await expect(source(page)).toHaveValue(text);expect(writes).toBe(1);const receipt=await f.call('runtime.receipt.read',{requestId:original});expect(receipt.result.status).toBe('DRAFT');expect(await f.source(receipt.result.revisionId)).toBe(text);
});

test('permission revocation requires reconnect without losing unsaved YAML; read identity cannot edit',async({page,browser})=>{
 await login(page);await valid(page);const text=f.initialSource+'\n# preserved through auth loss';f.rotate();await source(page).fill(text);await expect(page.getByLabel('一次性连接码')).toBeVisible();await page.getByLabel('一次性连接码').fill(await f.code());await page.getByRole('button',{name:'连接项目',exact:true}).click();await expect(source(page)).toHaveValue(text);await expect(source(page)).toBeEditable();
 const context=await browser.newContext(),reader=await context.newPage();await login(reader,'/lifecycle','reader');await expect(source(reader)).toHaveAttribute('readonly','');await expect(reader.getByRole('button',{name:'保存草稿',exact:true})).toBeDisabled();await expect(reader.getByRole('button',{name:'保存并启用'})).toBeDisabled();await context.close();
});

test('monitor shows real persisted instance events and UNKNOWN receipts with fixed revision, no editor or execution traffic',async({page},info)=>{
 await f.activate();await login(page,'/monitor');await expect(page.getByRole('heading',{name:'暂无生命周期实例'})).toBeVisible();const requests=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))requests.push(new URL(r.url()).pathname);});
 const instance=await f.createInstance();await expect(page.getByLabel('生命周期实例',{exact:true})).toHaveValue(instance.id);await expect(page.locator('tbody .status')).toHaveCount(8);await expect(page.locator('tbody .status.PENDING')).toHaveCount(8);
 await f.write('lifecycle.stage.request',{instanceId:instance.id,stageId:'scope'},'executor');await expect(page.locator('tbody .status.UNKNOWN')).toHaveCount(1);await expect(page.locator('tbody .status.PASSED')).toHaveCount(0);await page.locator('tbody').getByRole('button',{name:'范围定义'}).click();await expect(page.getByRole('heading',{name:'范围定义 · 观测详情'})).toBeVisible();
 await f.activate(f.initialSource+'\n# later definition');await expect(page.locator('.instance-pins code').first()).toHaveText(instance.revisionId);expect((await f.call('lifecycle.definition.inspect')).active.id).not.toBe(instance.revisionId);
 await page.screenshot({path:info.outputPath('monitor-desktop.png'),fullPage:true});await expect(source(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'保存草稿'})).toHaveCount(0);await expect(page.getByRole('button',{name:'保存并启用'})).toHaveCount(0);expect(requests.every(p=>['/api/v1/dashboard/monitor','/api/v1/dashboard/events'].includes(p))).toBe(true);expect(f.controls.dispatches).toBe(1);
});

test('narrow viewport, malformed YAML, unsaved navigation and keyboard access do not hide recovery controls',async({page},info)=>{
 await page.setViewportSize({width:390,height:844});await login(page);await valid(page);await page.screenshot({path:info.outputPath('editor-mobile.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await source(page).fill('projectId: alpha\na: [');await expect(page.getByRole('alert').filter({hasText:'YAML 语法错误'})).toBeVisible();await expect(source(page)).toHaveValue('projectId: alpha\na: [');await expect(page.getByRole('button',{name:'保存并启用'})).toBeDisabled();page.once('dialog',d=>d.dismiss());await page.getByRole('link',{name:'实时监控'}).click();await expect(source(page)).toBeVisible();
 page.once('dialog',d=>d.accept());await page.getByRole('link',{name:'实时监控'}).click();await expect(page.getByRole('heading',{name:'生命周期监控',exact:true})).toBeVisible();await expect(source(page)).toHaveCount(0);await page.keyboard.press('Control+Home');await page.keyboard.press('Tab');await page.screenshot({path:info.outputPath('monitor-empty-mobile.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('invalid graph falls back without deleting YAML; a corrected DAG restores actual rendering',async({page})=>{
 await login(page);await valid(page);const value=parse(f.initialSource);value.extensions=[extension('one','after-plan',['project.two']),extension('two','after-plan',['project.one'])];const invalid=yaml(value);await source(page).fill(invalid);await expect(page.getByRole('alert').filter({hasText:'图形暂不可用'})).toBeVisible();await expect(source(page)).toHaveValue(invalid);await expect(page.getByRole('button',{name:'保存并启用'})).toBeDisabled();
 await page.getByRole('alert').getByRole('button',{name:'project.one',exact:true}).click();await expect(page.getByLabel('扩展属性（JSON）')).toBeVisible();await page.getByLabel('扩展属性（JSON）').fill(JSON.stringify(extension('one')));await page.getByRole('button',{name:'应用扩展属性'}).click();await valid(page);await expect(page.getByRole('alert').filter({hasText:'图形暂不可用'})).toHaveCount(0);await expect(node(page,'project.one')).toBeVisible();
});

test('live monitor revocation closes access, keeps no editing controls, and reconnect restores original UNKNOWN state',async({page},info)=>{
 await f.activate();const instance=await f.createInstance();await f.write('lifecycle.stage.request',{instanceId:instance.id,stageId:'scope'},'executor');await login(page,'/monitor','reader');await expect(page.locator('tbody .status.UNKNOWN')).toHaveCount(1);f.rotate('reader');await expect(page.getByLabel('一次性连接码')).toBeVisible();await expect(page.getByRole('heading',{name:'生命周期监控',exact:true})).not.toBeVisible();await page.getByLabel('一次性连接码').fill(await f.code('reader'));await page.getByRole('button',{name:'连接项目',exact:true}).click();await expect(page.locator('tbody .status.UNKNOWN')).toHaveCount(1);
 await expect(page.getByRole('heading',{name:'生命周期监控',exact:true})).toBeVisible();await expect(page.locator('tbody .status.UNKNOWN')).toBeVisible();await page.setViewportSize({width:390,height:844});await expect.poll(async()=>Math.round((await page.locator('tbody td').first().boundingBox()).width)).toBeGreaterThanOrEqual(120);await page.screenshot({path:info.outputPath('monitor-mobile.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(source(page)).toHaveCount(0);expect(f.controls.dispatches).toBe(1);
});

test('interrupted monitor transport recovers by readback without changing stages or dispatching',async({page})=>{
 await f.activate();const instance=await f.createInstance();await page.route('**/api/v1/dashboard/events*',route=>route.abort('connectionrefused'));await page.route('**/api/v1/dashboard/monitor*',route=>route.abort('connectionrefused'));await login(page,'/monitor','reader');await expect(page.getByRole('alert')).toContainText('Runtime 服务暂时无法连接');await expect(page.locator('.connection.offline')).toBeVisible();await expect(page.locator('.status.PASSED')).toHaveCount(0);
 await page.unroute('**/api/v1/dashboard/monitor*');await page.unroute('**/api/v1/dashboard/events*');await expect(page.getByLabel('生命周期实例',{exact:true})).toHaveValue(instance.id);await expect(page.locator('.connection.online')).toBeVisible();await expect(page.locator('tbody .status.PENDING')).toHaveCount(8);expect(f.controls.dispatches).toBe(0);
});

test('an expired actual replay cursor preserves stale state until snapshot recovery and retains its gap explanation',async({page},info)=>{
 test.setTimeout(120000);await f.activate();const original=await f.createInstance();
 const cdp=await page.context().newCDPSession(page),frames=[],actions=[],requests=[];let outcome='RUNNING';await cdp.send('Network.enable');
 const action=(name,details={})=>actions.push({at:new Date().toISOString(),action:name,...details});
 cdp.on('Network.eventSourceMessageReceived',frame=>{let data;try{data=JSON.parse(frame.data);}catch{data=frame.data;}frames.push({at:new Date().toISOString(),requestId:frame.requestId,event:frame.eventName,data});});
 page.on('request',request=>{if(['/api/v1/dashboard/events','/api/v1/dashboard/monitor'].includes(new URL(request.url()).pathname))requests.push({at:new Date().toISOString(),url:request.url()});});
 try{
 await login(page,'/monitor','reader');await expect(page.getByLabel('生命周期实例',{exact:true})).toHaveValue(original.id);
 await expect.poll(()=>frames.filter(frame=>frame.event==='snapshot').length).toBeGreaterThan(0);
 const first=frames.find(frame=>frame.event==='snapshot').data;expect(first.events).toEqual([]);expect(first.gap).toBeNull();
 action('original-snapshot',{watermark:first.watermark,cursor:first.cursor});
 // Refuse new reads, then close the native response socket: neither synthetic
 // EventSource frames nor front-end state replace the real transport failure.
 await page.route('**/api/v1/dashboard/monitor*',route=>route.abort('connectionrefused'));
 await page.route('**/api/v1/dashboard/events*',route=>route.abort('connectionrefused'));
 const disconnected=f.disconnectEvents();action('destroy-native-event-responses',{count:disconnected});expect(disconnected).toBe(1);
 await expect(page.locator('.connection.offline')).toBeVisible({timeout:15000});const frameCount=frames.length;
 action('append-native-events-start',{count:1001});const revision=await f.appendEvents(1001);await f.createInstance('after-window');action('append-native-events-complete',{draftRevision:revision});
 expect(frames).toHaveLength(frameCount);action('resume-event-transport');await page.unroute('**/api/v1/dashboard/events*');
 await expect.poll(()=>frames.filter(frame=>frame.event==='reset').length,{timeout:15000}).toBeGreaterThan(0);
 const reset=frames.find(frame=>frame.event==='reset').data;expect(reset.projectId).toBe('alpha');expect(reset.gap.code).toBe('CURSOR_EXPIRED');expect(reset.gap.afterRevision).toBe(first.watermark.revision);expect(reset.gap.resumeRevision-reset.gap.afterRevision).toBeGreaterThan(1000);expect(reset.events).toEqual([]);
 await expect(page.getByTestId('monitor-recovery')).toContainText('正在核对当前快照');await expect(page.locator('.connection.offline')).toBeVisible();await expect(page.locator('#instance option')).toHaveCount(1);await expect(page.getByLabel('生命周期实例',{exact:true})).toHaveValue(original.id);await expect(page.locator('tbody .status.PENDING')).toHaveCount(8);
 await page.screenshot({path:info.outputPath('replay-gap-pending.png'),fullPage:true});
 action('resume-snapshot-transport');await page.unroute('**/api/v1/dashboard/monitor*');
 await expect(page.getByTestId('monitor-recovery')).toContainText(/已通过修订 \d+ 的当前快照恢复/,{timeout:15000});await expect(page.locator('#instance option')).toHaveCount(2);await expect(page.locator('.connection.online')).toBeVisible();
 const heartbeatCount=frames.filter(frame=>frame.event==='heartbeat').length;await expect.poll(()=>frames.filter(frame=>frame.event==='heartbeat').length).toBeGreaterThan(heartbeatCount);
 await expect(page.getByTestId('monitor-recovery')).toContainText('未逐条重放，已通过修订');await expect(page.getByLabel('Project Lifecycle YAML')).toHaveCount(0);expect(f.controls.dispatches).toBe(0);
 await page.screenshot({path:info.outputPath('replay-gap-recovered.png'),fullPage:true});outcome='PASSED';
 }catch(error){outcome='FAILED';action('failure',{message:error instanceof Error?error.message:String(error)});throw error;}
 finally{await info.attach('replay-gap-frames.json',{body:Buffer.from(JSON.stringify({outcome,frames},null,2)),contentType:'application/json'});await info.attach('replay-gap-actions.json',{body:Buffer.from(JSON.stringify({outcome,actions,requests},null,2)),contentType:'application/json'});await cdp.detach();}
});

test('a rejected initial browser cursor reconnects without confusing invalid input with an expired replay gap',async({page})=>{
 await f.activate();const instance=await f.createInstance(),cdp=await page.context().newCDPSession(page),frames=[],attempts=[];await cdp.send('Network.enable');
 cdp.on('Network.eventSourceMessageReceived',frame=>frames.push({event:frame.eventName,data:JSON.parse(frame.data)}));
 await page.route('**/api/v1/dashboard/events*',async route=>{attempts.push(route.request().url());await route.continue(attempts.length===1?{url:f.url+'/api/v1/dashboard/events?cursor=invalid-reference'}:{});});
 await login(page,'/monitor','reader');await expect.poll(()=>frames.filter(frame=>frame.event==='error'&&frame.data.code==='INVALID_CURSOR').length).toBe(1);
 await expect.poll(()=>attempts.length,{timeout:10000}).toBeGreaterThan(1);expect(new URL(attempts[1]).searchParams.has('cursor')).toBe(false);
 await expect(page.locator('.connection.online')).toBeVisible();await expect(page.getByLabel('生命周期实例',{exact:true})).toHaveValue(instance.id);await expect(page.getByTestId('monitor-recovery')).toHaveCount(0);expect(frames.some(frame=>frame.event==='reset')).toBe(false);expect(f.controls.dispatches).toBe(0);await cdp.detach();
});

test('monitor pagination exposes the remaining instances without requesting definition source',async({page})=>{
 await f.activate();for(let n=0;n<51;n++)await f.createInstance('instance-'+String(n).padStart(3,'0'));
 const operations=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/request'))operations.push(r.postDataJSON().operation);});await login(page,'/monitor','reader');await expect(page.getByRole('button',{name:'加载更多实例'})).toBeVisible();await page.getByRole('button',{name:'加载更多实例'}).click();await expect(page.locator('#instance option')).toHaveCount(51);await page.getByLabel('生命周期实例',{exact:true}).selectOption('instance-050');await expect(page.locator('tbody .status.PENDING')).toHaveCount(8);await expect(page.getByRole('button',{name:'加载更多实例'})).toHaveCount(0);expect(operations).toEqual([]);
});

test('a concurrent revision after commit but before readback cannot silently authorize the next overwrite',async({page})=>{
 await login(page);await valid(page);const local=f.initialSource+'\n# local committed source',concurrent=f.initialSource+'\n# later agent source';await source(page).fill(local);
 await page.route('**/api/v1/dashboard/request',async route=>{if(route.request().postDataJSON().operation==='lifecycle.draft.save'){const response=await route.fetch();expect(response.status()).toBe(200);await f.write('lifecycle.draft.save',{yaml:concurrent});await route.fulfill({response});}else await route.continue();});
 await page.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page.getByRole('button',{name:'重新读取',exact:true})).toBeVisible();await expect(source(page)).toHaveValue(local);await expect(page.getByRole('button',{name:'保存草稿',exact:true})).toBeDisabled();expect(await f.source((await f.call('lifecycle.definition.inspect')).draft.id)).toBe(concurrent);
});

test('existing positioned node and newly added extensions remain visible in actual SeeCode without changing saved YAML coordinates',async({page})=>{
 await login(page);const value=parse(f.initialSource);value.presentation={layout:{scope:{x:400,y:180}}};value.extensions=[extension('existing'),extension('second')];
 const original='# Preserve explicit graph position\n'+yaml(value);await source(page).fill(original);await valid(page);
 await page.getByText('添加项目扩展',{exact:true}).click();await page.getByLabel('扩展标识',{exact:true}).fill('project.third');await page.getByRole('button',{name:'加入草稿'}).click();
 await expect(node(page,'project.third')).toBeVisible();await node(page,'project.third').click();await page.getByLabel('扩展属性（JSON）').fill(JSON.stringify(extension('third')));await page.getByRole('button',{name:'应用扩展属性'}).click();await valid(page);
 await expect(page.getByRole('alert').filter({hasText:'图形暂不可用'})).toHaveCount(0);await expect(page.locator('svg [data-sc-node]')).toHaveCount(11);
 const edited=await page.getByLabel('Project Lifecycle YAML').inputValue();expect(parse(edited).presentation.layout.scope).toEqual({x:400,y:180});expect(edited).toContain('# Preserve explicit graph position');await save(page);expect(await f.source((await f.call('lifecycle.definition.inspect')).draft.id)).toBe(edited);
});
