/** Local compatibility wiring for the exact published Harness online APIs.
 * Harness owns collection, alert authentication and evaluation. Configuration
 * references do not select monitoring, start a worker or approve a repair. */
import {join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonical,digest,exact,record,reject,string} from '../server/errors.js';
import {readRegular,canonicalPath} from '../compat/project/files.js';
import {verifyOwnerDistribution} from '../adapters/published-owners.js';
import {nativeSha256,nativeFrozenClone,type NativeScope} from '../../vendor/compatibility/v1/native.mjs';
import {feedbackScope} from '../../vendor/compatibility/feedback/v1/feedback.mjs';
import {ONLINE_LIMITS,onlineSlug,type OnlineProviderInput,type OnlineMeasurement,type OnlineAlertBatch} from '../../vendor/compatibility/online/v1/online.mjs';

export interface PrometheusConnection {id:string;origin:string;bearerTokenFile:string|null;freshnessSeconds:number;}
export interface AlertmanagerConnection {id:string;bearerTokenFile:string;}
export interface OnlineSettings {scopes:NativeScope[];prometheus:PrometheusConnection[];alertmanager:AlertmanagerConnection[];receiverPort:number;tickSeconds:number;}
export interface OnlineConfiguration {schema:'evopilot-online-configuration/v1';workspaceId:string;settings:OnlineSettings;digest:string;}
export interface OnlineRegistration {ref:string;digest:string;}
interface AlertReceiver {
  receive(sourceId:string,authorization:string|undefined,body:Buffer,consume:(batch:OnlineAlertBatch)=>Promise<unknown>):Promise<unknown>;
  inspect(input:{sourceId:string;digest:string}):Promise<OnlineAlertBatch>;
}
interface HarnessOnlineModule {
  validatePrometheusConnection(value:unknown):void;
  createPrometheusCollector(connections:readonly PrometheusConnection[]):(input:OnlineProviderInput)=>Promise<OnlineMeasurement>;
  createAlertmanagerReceiver(connections:readonly AlertmanagerConnection[]):AlertReceiver;
}
export function validateOnlineRegistration(value:unknown):OnlineRegistration {
  const v=record(value);exact(v,['ref','digest']);canonicalPath(string(v.ref,4096));
  if(!/^[a-f0-9]{64}$/.test(string(v.digest,64)))reject('ONLINE_CONFIGURATION_PIN','Select the exact protected online configuration digest');
  return v as unknown as OnlineRegistration;
}
/** Passive metadata read. Secrets are consumed only by the published adapters. */
export function readOnlineConfiguration(selection:OnlineRegistration,workspaceId:string):OnlineConfiguration {
  validateOnlineRegistration(selection);
  const v=record(JSON.parse(readRegular(selection.ref,1048576,true).toString()));
  exact(v,['schema','workspaceId','settings','digest']);
  if(digest(v)!==selection.digest)reject('ONLINE_CONFIGURATION_CHANGED','Reconnect after an explicit online configuration change',409);
  const {digest:contentDigest,...subject}=v;
  if(v.schema!=='evopilot-online-configuration/v1'||v.workspaceId!==workspaceId||contentDigest!==nativeSha256(subject))reject('ONLINE_CONFIGURATION_IDENTITY','Online configuration differs from the selected workspace or original content digest',409);
  const settings=record(v.settings);exact(settings,['scopes','prometheus','alertmanager','receiverPort','tickSeconds']);
  for(const key of ['scopes','prometheus','alertmanager']){
    const values=settings[key];if(!Array.isArray(values)||!values.length||values.length>ONLINE_LIMITS.bindings)reject('ONLINE_CONFIGURATION_LIMIT','Online configuration must contain bounded explicit connections and scopes');
  }
  const scopes=settings.scopes as unknown[];scopes.forEach(feedbackScope);
  if(new Set(scopes.map(canonical)).size!==scopes.length)reject('ONLINE_CONFIGURATION_SCOPE','Duplicate online scope');
  for(const key of ['prometheus','alertmanager']){
    const values=settings[key] as unknown[],ids=new Set<string>();
    for(const raw of values){const row=record(raw);exact(row,key==='prometheus'?['id','origin','bearerTokenFile','freshnessSeconds']:['id','bearerTokenFile']);onlineSlug(row.id);
      if(ids.has(String(row.id)))reject('ONLINE_CONFIGURATION_DUPLICATE','Connection identifiers must be unique');ids.add(String(row.id));
      if(row.bearerTokenFile!==null||key==='alertmanager'){
        if(!isAbsolute(string(row.bearerTokenFile,4096)))reject('ONLINE_CREDENTIAL_PATH','Use a private credential file reference');
      }
      if(key==='prometheus'){string(row.origin,2048);if(!Number.isSafeInteger(row.freshnessSeconds)||Number(row.freshnessSeconds)<1||Number(row.freshnessSeconds)>300)reject('ONLINE_CONFIGURATION_LIMIT','Bounded observation freshness required');}
    }
  }
  if(!Number.isSafeInteger(settings.receiverPort)||Number(settings.receiverPort)<1024||Number(settings.receiverPort)>65535||!Number.isSafeInteger(settings.tickSeconds)||Number(settings.tickSeconds)<1||Number(settings.tickSeconds)>300)reject('ONLINE_CONFIGURATION_LIMIT','Bounded receiver port and tick interval required');
  return nativeFrozenClone(v) as unknown as OnlineConfiguration;
}

export async function openPublishedOnlineAdapters(packageRoot:string,selection:OnlineRegistration,workspaceId:string,assertCurrent:()=>void){
  assertCurrent();const configuration=readOnlineConfiguration(selection,workspaceId);
  verifyOwnerDistribution('harness',packageRoot);
  const loaded=await import(pathToFileURL(join(packageRoot,'dist/online.js')).href) as Record<string,unknown>;
  for(const name of ['validatePrometheusConnection','createPrometheusCollector','createAlertmanagerReceiver'])if(typeof loaded[name]!=='function')reject('ONLINE_CAPABILITY','The selected published Harness lacks its online adapter');
  const api=loaded as unknown as HarnessOnlineModule;
  configuration.settings.prometheus.forEach(api.validatePrometheusConnection);
  const collect=api.createPrometheusCollector(configuration.settings.prometheus),receiver=api.createAlertmanagerReceiver(configuration.settings.alertmanager);
  const fresh=()=>{assertCurrent();readOnlineConfiguration(selection,workspaceId);verifyOwnerDistribution('harness',packageRoot);};
  function scope(scope:NativeScope){fresh();if(!configuration.settings.scopes.some(s=>canonical(s)===canonical(scope)))reject('ONLINE_SCOPE','Online access is outside its explicit configured scope',403);}
  fresh();
  return{configuration,
    async collectOnline(input:OnlineProviderInput):Promise<OnlineMeasurement>{
      scope(input.binding.scope);if(input.binding.workspaceId!==workspaceId)reject('ONLINE_SCOPE','Online binding belongs to another workspace',403);
      const value=await collect(input);scope(input.binding.scope);return value;
    },
    async inspectOnlineAlert(input:{sourceId:string;digest:string}):Promise<OnlineAlertBatch>{fresh();const value=await receiver.inspect(input);fresh();return value;},
    async receive(sourceId:string,authorization:string|undefined,body:Buffer,consume:(batch:OnlineAlertBatch)=>Promise<unknown>):Promise<unknown>{
      fresh();const value=await receiver.receive(sourceId,authorization,body,async batch=>{fresh();const result=await consume(batch);fresh();return result;});fresh();return value;
    },
  };
}
export type PublishedOnlineAdapters=Awaited<ReturnType<typeof openPublishedOnlineAdapters>>;
