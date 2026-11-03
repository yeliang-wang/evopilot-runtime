import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {projectFixture,put} from './legacy-project-v090.mjs';
import {createRuntimeService} from '../../dist/service.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {inspectLegacyWorkspace,createLegacyBackup,adoptLegacyWorkspace} from '../../dist/installation/migration.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {createRuntimeHttpClient} from '../../dist/host/client.js';
import {forwardLegacyRuntime} from '../../dist/host/legacy-tools.js';

// Isolated synthetic project/decisions; actual service, migration and HTTP.
export async function providerFixture(t){
 const f=projectFixture(),frozen=await f.freeze(),old=createRuntimeService({workspaceRoot:f.stateRoot,workspaceId:f.workspaceId});old.initialize();old.execute({operation:'project.create',scope:f.scope,input:{name:'Synthetic provider project'},requestId:'project',expectedRevision:0});old.execute({operation:'goal.create',scope:f.scope,input:{id:'goal',description:'Synthetic provider tests'},requestId:'goal',expectedRevision:1});await old.native({operation:'workspace.inspect',scope:f.scope,input:{}});old.close();
 const serviceRoot=join(f.root,'service'),token=randomBytes(32).toString('base64url'),principals=[{id:'editor',projects:['synthetic'],permissions:['read','draft.write','execution.request','decision.record'],revision:1,expiresAt:'2030-01-01T00:00:00Z',tokenDigest:tokenDigest(token)}];initializeCredentials(serviceRoot,f.workspaceId,principals);const store=new RuntimeStore(serviceRoot,f.workspaceId),serviceId=store.serviceId;store.close();
 const snapshot=inspectLegacyWorkspace(f.stateRoot,f.workspaceId),backupRoot=join(f.root,'backup'),backup=createLegacyBackup(f.stateRoot,f.workspaceId,snapshot.snapshotDigest,backupRoot),adopted=adoptLegacyWorkspace({workspaceRoot:f.stateRoot,workspaceId:f.workspaceId,serviceId,expectedSnapshotDigest:snapshot.snapshotDigest,backupRoot,expectedBackupDigest:backup.backupDigest}),bindingRef=join(f.root,'binding.json');put(bindingRef,adopted.binding);
 let context,hook=async()=>{},calls=0;
 const factory=c=>{context=c;return{nativeStandards:f.input.standardPins,inspectSource:async request=>{calls++;c.current();await c.read('native',{operation:'workspace.inspect',scope:request.scope,input:{}});await hook(c,request);c.current();return f.service.inspectSource(request);},resolveRequirements:request=>{c.current();return f.service.resolveRequirements(request);}};};
 const server=await startRuntimeServer({stateRoot:serviceRoot,workspaceId:f.workspaceId,legacyBindingRef:bindingRef},undefined,undefined,undefined,undefined,undefined,undefined,undefined,factory),tokenRef=join(f.root,'token.json'),connectionRef=join(f.root,'connection.json');put(tokenRef,{schema:'runtime-client-credential/v1',workspaceId:f.workspaceId,principalId:'editor',projectId:'synthetic',token});put(connectionRef,{schema:'runtime-host-connection/v1',origin:server.url,workspaceId:f.workspaceId,projectId:'synthetic',principalId:'editor',serviceId,version:server.identity.version,tokenRef});const client=createRuntimeHttpClient(connectionRef);
 t.after(async()=>{await server.close();f.cleanup();});
 const prepare={operation:'project.prepare',scope:f.scope,input:{id:'prepared',goalId:'goal',sourceScope:frozen.candidate.sourceScope,standardPins:f.input.standardPins,requirements:frozen.candidate.nativeRequirements},requestId:'prepare',expectedRevision:0};
 return{...f,serviceRoot,principals,context,client,bindingRef,prepare,calls:()=>calls,setHook:v=>hook=v,send:envelope=>forwardLegacyRuntime(client,'native',envelope)};
}
