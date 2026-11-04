// SYNTHETIC preservation/configuration tests. No external telemetry or worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {relocationConfigurationFixture} from '../fixtures/relocation-configuration-v090.mjs';
import {canonical,digest} from '../../dist/server/errors.js';
import {nativeSha256} from '../../vendor/compatibility/v1/native.mjs';
import {runtimePluginMaterial} from '../../dist/host/plugin.js';
import {onlinePreservationReferences} from '../../dist/installation/online/preservation.js';
import {prepareRelocationConfiguration} from '../../dist/installation/workspace/configuration.js';
import {inspectManagedWorkspace} from '../../dist/installation/workspace/snapshot.js';
import {createManagedWorkspaceBackup,verifyManagedWorkspaceBackup} from '../../dist/installation/workspace/backup.js';
import {inspectMaintenanceTree} from '../../dist/installation/workspace/stream.js';
import {readOnlineConfiguration} from '../../dist/host/online.js';
import {readLegacyOwnerHostConfiguration} from '../../dist/host/legacy-owners.js';

const put=(ref,value)=>{fs.mkdirSync(dirname(ref),{recursive:true,mode:0o700});fs.writeFileSync(ref,Buffer.isBuffer(value)?value:typeof value==='string'?value:canonical(value)+'\n',{mode:0o600});};
const read=ref=>JSON.parse(fs.readFileSync(ref)),node=fs.realpathSync(process.execPath);
function fixture(t,{external=false,unbound=false,firstUse=false}={}){
  const f=relocationConfigurationFixture(t,true,true,true),s=f.source,d=f.destination;
  const secrets={metrics:join(s.workspaceRoot,'synthetic-metrics.token'),alerts:join(s.projectRoot,'synthetic-alerts.token'),external:join(f.root,'external-alert.token')};
  for(const [name,ref] of Object.entries(secrets)){put(ref,'synthetic-online-'+name+'-not-a-real-secret');for(const role of ['projectRoot','workspaceRoot','serviceRoot'])if(ref.startsWith(s[role]+'/'))put(d[role]+ref.slice(s[role].length),fs.readFileSync(ref));}
  const subject={schema:'evopilot-online-configuration/v1',workspaceId:s.workspaceId,settings:{scopes:[{visibility:'private',projectId:'synthetic'},{visibility:'private',projectId:'secondary'}],prometheus:[{id:'metrics',origin:'http://127.0.0.1:18931',bearerTokenFile:secrets.metrics,freshnessSeconds:30},{id:'public',origin:'http://127.0.0.1:18932',bearerTokenFile:null,freshnessSeconds:30}],alertmanager:[{id:'external',bearerTokenFile:secrets.external},{id:'local',bearerTokenFile:secrets.alerts}],receiverPort:18933,tickSeconds:30}};
  const online={...subject,digest:nativeSha256(subject)},ref=external?join(f.root,'external-online.json'):join(s.workspaceRoot,'online/configuration.json');put(ref,online);
  if(!external)put(join(d.workspaceRoot,'online/configuration.json'),online);
  const registration={ref,digest:digest(online)};
  let primary=read(f.ownerHost.ownerConfigRef),operator={...f.operatorConfig};
  if(!unbound){
    primary={...primary,online:registration};primary.owners.harness.calls.push('native:online.inspect','native:online.tick','native:online.alert.ingest');put(f.ownerHost.ownerConfigRef,primary);
    f.ownerHost={...f.ownerHost,ownerConfigDigest:digest(primary)};
    const credential={schema:'runtime-client-credential/v1',workspaceId:s.workspaceId,projectId:'secondary',principalId:'secondary',token:'synthetic_secondary_credential_1234567890abcdef'};
    const tokenRef=join(s.workspaceRoot,'secondary-client.json');put(tokenRef,credential);put(join(d.workspaceRoot,'secondary-client.json'),credential);
    const connection={...read(join(s.serviceRoot,'connection.json')),projectId:'secondary',principalId:'secondary',tokenRef};
    const connectionRef=join(s.serviceRoot,'secondary-connection.json');put(connectionRef,connection);put(join(d.serviceRoot,'secondary-connection.json'),connection);
    const secondary={...primary,projectId:'secondary'},ownerConfigRef=join(f.root,'secondary-owner.json');put(ownerConfigRef,secondary);
    operator={...operator,ownerHost:{ownerConfigRef:f.ownerHost.ownerConfigRef,ownerConfigDigest:f.ownerHost.ownerConfigDigest},calls:[...operator.calls,'online_configure','online_worker'],online:{hosts:[{connectionRef:join(s.serviceRoot,'connection.json'),ownerConfigRef:f.ownerHost.ownerConfigRef,ownerConfigDigest:f.ownerHost.ownerConfigDigest},{connectionRef,ownerConfigRef,ownerConfigDigest:digest(secondary)}]}};
  }
  put(f.ownerHost.workspaceConfigRef,operator);put(join(d.serviceRoot,'workspace-operator.json'),operator);f.ownerHost.workspaceConfigDigest=digest(operator);f.operatorConfig=operator;
  let pluginSelection={...f.ownerHost};
  if(firstUse){
    const setup={schema:'runtime-workspace-setup-operator/v1',projectRoot:s.projectRoot,workspaceRoot:s.workspaceRoot,owners:operator.owners,ownerHost:{ref:f.ownerHost.ownerConfigRef,digest:f.ownerHost.ownerConfigDigest},workspaceOperator:{projectRoot:s.projectRoot,referenceFiles:s.referenceFiles,owners:operator.owners,calls:operator.calls,expiresAt:operator.expiresAt,online:operator.online},serviceAfterSetup:'running',expiresAt:operator.expiresAt,serviceRoot:s.serviceRoot,workspaceId:s.workspaceId,serviceId:s.serviceId,connectionRef:operator.connectionRef,installationPlanDigest:'a'.repeat(64),specificationDigest:'b'.repeat(64),connectionDigest:digest(read(operator.connectionRef))};
    const setupRef=join(s.serviceRoot,'workspace-setup.json');for(const location of [s,d]){put(join(location.serviceRoot,'workspace-setup.json'),setup);put(join(location.serviceRoot,'package/dist/installation/setup-host.js'),'// synthetic entry, never executed\n');}
    pluginSelection={...pluginSelection,setupConfigRef:setupRef,setupConfigDigest:digest(setup)};
  }
  const plugin=runtimePluginMaterial(f.spec.packageRoot,join(s.serviceRoot,'connection.json'),node,pluginSelection);for(const [name,bytes] of plugin.files)for(const location of [s,d])put(join(location.serviceRoot,'plugin',name),bytes);
  return{...f,secrets,online,registration,primary};
}
const prepare=f=>prepareRelocationConfiguration(f.source,f.destination,f.ownerHost);
const trees=s=>['projectRoot','workspaceRoot','serviceRoot'].map(role=>inspectMaintenanceTree(s[role]));
function apply(f,m){for(const p of m.patches){const ref=join(p.role==='workspace'?f.destination.workspaceRoot:f.destination.serviceRoot,p.path);put(ref,p.bytes);if(p.mode)fs.chmodSync(ref,p.mode);}}

test('backup includes every explicitly selected project connection and external online secret without putting secret values in its manifest',async t=>{
  const f=fixture(t),before=trees(f.source),refs=onlinePreservationReferences(f.source);
  for(const ref of [f.registration.ref,...Object.values(f.secrets),...f.operatorConfig.online.hosts.flatMap(h=>[h.connectionRef,h.ownerConfigRef]),join(f.source.workspaceRoot,'secondary-client.json')])assert(refs.includes(ref),ref);
  const snapshot=await inspectManagedWorkspace(f.source,'online-inspect');assert(snapshot.references.some(r=>r.path===f.secrets.external));assert(!JSON.stringify(snapshot).includes('not-a-real-secret'));
  const saved=await createManagedWorkspaceBackup(f.source,'online-backup',snapshot.snapshotDigest,f.backupRoot);assert.deepEqual(verifyManagedWorkspaceBackup(f.backupRoot,saved.backupDigest),saved);assert.deepEqual(trees(f.source),before);
  put(f.secrets.external,'changed-external-secret');await assert.rejects(createManagedWorkspaceBackup(f.source,'changed-online',snapshot.snapshotDigest,join(f.root,'another-backup')),{code:'MAINTENANCE_DRIFT'});
});

test('relocation maps canonical configuration, both project bindings and internal credentials while preserving scope, grants and original history',t=>{
  const f=fixture(t),before=trees(f.source),m=prepare(f);
  assert(!m.patches.some(p=>p.bytes.includes('not-a-real-secret')));assert(m.sourcePins.some(p=>p.path===f.secrets.external));
  const originalDigest=f.online.digest,patch=m.patches.find(p=>p.role==='workspace'&&p.path==='online/configuration.json');assert(patch);
  apply(f,{patches:[patch]});assert.equal(prepare(f).materialDigest,m.materialDigest,'same partial configuration remains recoverable');apply(f,m);
  const owner=readLegacyOwnerHostConfiguration(m.ownerHost.ownerConfigRef),online=readOnlineConfiguration(owner.online,f.source.workspaceId),operator=read(m.ownerHost.workspaceConfigRef);
  assert.equal(owner.online.ref,join(f.destination.workspaceRoot,'online/configuration.json'));assert.notEqual(online.digest,originalDigest);assert.deepEqual(online.settings.scopes,f.online.settings.scopes);
  assert.equal(online.settings.prometheus[0].bearerTokenFile,join(f.destination.workspaceRoot,'synthetic-metrics.token'));assert.equal(online.settings.prometheus[1].bearerTokenFile,null);
  assert.equal(online.settings.alertmanager[0].bearerTokenFile,f.secrets.external);assert.equal(online.settings.alertmanager[1].bearerTokenFile,join(f.destination.projectRoot,'synthetic-alerts.token'));
  assert.deepEqual(operator.calls,f.operatorConfig.calls);assert.equal(operator.expiresAt,f.operatorConfig.expiresAt);assert.deepEqual(owner.owners,f.primary.owners);assert.equal(owner.expiresAt,f.primary.expiresAt);
  assert.equal(operator.online.hosts.length,2);for(const h of operator.online.hosts){const c=read(h.connectionRef),o=readLegacyOwnerHostConfiguration(h.ownerConfigRef);assert.equal(digest(o),h.ownerConfigDigest);assert.equal(o.projectId,c.projectId);assert.deepEqual(o.online,owner.online);assert.equal(o.legacyBindingRef,join(f.destination.serviceRoot,'legacy-binding.json'));}
  const secondary=read(operator.online.hosts[1].connectionRef);assert.equal(secondary.tokenRef,join(f.destination.workspaceRoot,'secondary-client.json'));
  assert.deepEqual(trees(f.source),before);assert.equal(prepare(f).materialDigest,m.materialDigest);assert.equal(m.serviceStarted,false);assert.equal(m.hostRegistered,false);
  const refs=onlinePreservationReferences(f.destination);assert(!refs.some(ref=>[f.source.serviceRoot,f.source.workspaceRoot,f.source.projectRoot].some(root=>ref.startsWith(root+'/'))));
});

test('external online configuration stays immutable and all moved project Hosts share the exact new operational pin',t=>{
  const f=fixture(t,{external:true}),original=fs.readFileSync(f.registration.ref),m=prepare(f);apply(f,m);
  const operator=read(m.ownerHost.workspaceConfigRef),online=read(read(operator.online.hosts[0].ownerConfigRef).online.ref);
  assert.deepEqual(fs.readFileSync(f.registration.ref),original);assert.equal(online.settings.prometheus[0].bearerTokenFile,join(f.destination.workspaceRoot,'synthetic-metrics.token'));
  assert.deepEqual(read(operator.online.hosts[0].ownerConfigRef).online,read(operator.online.hosts[1].ownerConfigRef).online);assert.equal(prepare(f).materialDigest,m.materialDigest);
});

test('unbound original online configuration is preserved and remapped without granting new Host tools or selecting a worker',t=>{
  const f=fixture(t,{unbound:true}),m=prepare(f);assert(onlinePreservationReferences(f.source).includes(f.secrets.external));apply(f,m);
  const online=read(join(f.destination.workspaceRoot,'online/configuration.json')),operator=read(m.ownerHost.workspaceConfigRef);assert.notEqual(online.digest,f.online.digest);assert.equal(read(m.ownerHost.ownerConfigRef).online,undefined);assert.equal(operator.online,undefined);assert.deepEqual(operator.calls,f.operatorConfig.calls);assert.equal(prepare(f).materialDigest,m.materialDigest);
});

test('completed first-use online permissions survive relocation and the original setup wrapper is retained as history',t=>{
  const f=fixture(t,{firstUse:true}),original=fs.readFileSync(join(f.source.serviceRoot,'workspace-setup.json'));assert(onlinePreservationReferences(f.source).includes(f.secrets.external));
  const m=prepare(f);apply(f,m);const operator=read(m.ownerHost.workspaceConfigRef);assert.deepEqual(operator.calls,f.operatorConfig.calls);assert.equal(operator.online.hosts.length,2);assert.equal(operator.expiresAt,f.operatorConfig.expiresAt);
  assert.deepEqual(fs.readFileSync(join(f.destination.serviceRoot,'workspace-setup.json')),original);assert.equal(prepare(f).materialDigest,m.materialDigest);
});

test('changed copied credentials, mismatched per-project pins and missing or unsafe secrets are rejected without rewriting the source',t=>{
  {const f=fixture(t),file=join(f.destination.workspaceRoot,'synthetic-metrics.token'),before=trees(f.source);put(file,'foreign');assert.throws(()=>prepare(f),{code:'RELOCATION_CONFIGURATION_CHANGED'});assert.deepEqual(trees(f.source),before);}
  {const f=fixture(t);put(f.operatorConfig.online.hosts[1].ownerConfigRef,{...read(f.operatorConfig.online.hosts[1].ownerConfigRef),projectId:'foreign'});assert.throws(()=>prepare(f));assert.throws(()=>onlinePreservationReferences(f.source));}
  {const f=fixture(t);fs.unlinkSync(f.secrets.external);assert.throws(()=>onlinePreservationReferences(f.source));assert.throws(()=>prepare(f));}
  {const f=fixture(t);fs.chmodSync(f.secrets.external,0o644);assert.throws(()=>onlinePreservationReferences(f.source));assert.throws(()=>prepare(f));}
});

test('backup preserves expired owner grants as historical data without renewing them or admitting online work',t=>{
  const f=fixture(t),expired={...f.primary,expiresAt:'2001-01-01T00:00:00.000Z'};put(f.ownerHost.ownerConfigRef,expired);f.ownerHost.ownerConfigDigest=digest(expired);
  const c={...f.operatorConfig,ownerHost:{ownerConfigRef:f.ownerHost.ownerConfigRef,ownerConfigDigest:f.ownerHost.ownerConfigDigest},online:{hosts:f.operatorConfig.online.hosts.map((h,i)=>i===0?{...h,ownerConfigDigest:f.ownerHost.ownerConfigDigest}:h)}};
  put(f.ownerHost.workspaceConfigRef,c);f.ownerHost.workspaceConfigDigest=digest(c);const plugin=read(join(f.source.serviceRoot,'plugin/.mcp.json')),args=plugin.mcpServers.evopilot_runtime_legacy.args;args[args.indexOf('--owner-config-digest')+1]=f.ownerHost.ownerConfigDigest;args[args.indexOf('--operator-config-digest')+1]=f.ownerHost.workspaceConfigDigest;put(join(f.source.serviceRoot,'plugin/.mcp.json'),plugin);
  assert(onlinePreservationReferences(f.source).includes(f.secrets.external));assert.throws(()=>readLegacyOwnerHostConfiguration(f.ownerHost.ownerConfigRef),{code:'OWNER_HOST_EXPIRED'});assert.equal(read(f.ownerHost.ownerConfigRef).expiresAt,expired.expiresAt);
});
