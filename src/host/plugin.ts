import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {canonical,digest,exact,record,reject,string} from '../server/errors.js';
import {readHostConnection} from '../server/security.js';
import {readLegacyOwnerHostConfiguration} from './legacy-owners.js';
import {readLegacyBinding} from '../compat/gateway.js';

export const PLUGIN_NAME='evopilot-runtime';
export const PLUGIN_STATIC_FILES=[
  '.codex-plugin/plugin.json','skills/evopilot-runtime-expert/SKILL.md',
  'skills/evopilot-runtime-expert/agents/openai.yaml',
  ...['configuration','execution','recovery'].map(n=>'skills/evopilot-runtime-expert/references/'+n+'.md'),
] as const;
export interface PluginMaterial {name:typeof PLUGIN_NAME;version:string;files:ReadonlyMap<string,Buffer>;transport:'streamable-http';credentialEmbedded:false;}
export interface LegacyPluginSelection {ownerConfigRef?:string;ownerConfigDigest?:string;}
// Codex's helper field is a command string, not argv. Quote each fixed argument
// independently; a filesystem path must never become shell syntax.
export const quoteHelperArgument=(value:string):string=>"'"+value.replaceAll("'","'\"'\"'")+"'";
/** Prepare a single local plugin from this Runtime package. Installation owns
 * writing/registration; material generation alone never enables a Host. */
export function runtimePluginMaterial(packageRoot:string,connectionRef:string,nodeExecutable:string,legacy?:LegacyPluginSelection):PluginMaterial{
  for(const p of [packageRoot,nodeExecutable])if(!isAbsolute(p)||resolve(p)!==p||realpathSync(p)!==p)reject('INVALID_PLUGIN_PATH','Runtime package and Node executable must be canonical');
  if(!lstatSync(packageRoot).isDirectory()||!lstatSync(nodeExecutable).isFile())reject('INVALID_PLUGIN_PATH','Runtime package or Node executable is missing');
  const connection=readHostConnection(connectionRef),files=new Map<string,Buffer>(),root=join(packageRoot,'plugins/codex');
  for(const path of PLUGIN_STATIC_FILES){const absolute=join(root,path),stat=lstatSync(absolute);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||realpathSync(absolute)!==absolute)reject('PLUGIN_CONTENT','Plugin contains an unsafe or oversized entry');files.set(path,readFileSync(absolute));}
  const manifest=record(JSON.parse(files.get('.codex-plugin/plugin.json')!.toString('utf8'))),pkg=record(JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8')));
  exact(manifest,['name','version','description','skills','mcpServers','interface']);
  if(manifest.name!==PLUGIN_NAME||manifest.version!==pkg.version||manifest.version!==connection.version||manifest.skills!=='./skills/'||manifest.mcpServers!=='./.mcp.json')reject('PLUGIN_VERSION_MISMATCH','Plugin, Runtime package and selected service must share their exact independent version',409);
  const template=JSON.parse(readFileSync(join(root,'mcp.template.json'),'utf8')) as unknown,expected={mcpServers:{evopilot_runtime:{type:'http',url:'${runtimeOrigin}/mcp',http_headers_helper:'${nodeExecutable} ${headerHelperPath} --connection-ref ${connectionRef}'}}};
  if(canonical(template)!==canonical(expected))reject('PLUGIN_CONTENT','Unexpected Runtime MCP template');
  const helper=join(packageRoot,'dist/host/header-helper.js');if(!lstatSync(helper).isFile()||realpathSync(helper)!==helper)reject('PLUGIN_CONTENT','Compiled Runtime credential helper is missing');
  const servers:Record<string,unknown>={evopilot_runtime:{type:'http',url:connection.origin+'/mcp',http_headers_helper:[nodeExecutable,helper,'--connection-ref',connectionRef].map(quoteHelperArgument).join(' ')}};
  if(legacy){
    exact(record(legacy),[],['ownerConfigRef','ownerConfigDigest']);
    const bridge=join(packageRoot,'dist/host/bridge.js');if(!lstatSync(bridge).isFile()||realpathSync(bridge)!==bridge)reject('PLUGIN_CONTENT','Compiled compatibility entry is missing');
    const args=[bridge,'--connection-ref',connectionRef,'--legacy-only'];
    if(legacy.ownerConfigRef!==undefined||legacy.ownerConfigDigest!==undefined){
      const ref=string(legacy.ownerConfigRef,4096),config=readLegacyOwnerHostConfiguration(ref),binding=readLegacyBinding(config.legacyBindingRef);
      if(digest(config)!==legacy.ownerConfigDigest)reject('OWNER_HOST_CHANGED','Owner Host permission selection differs from its pinned digest',409);
      if(config.workspaceId!==connection.workspaceId||config.projectId!==connection.projectId||binding.workspaceId!==connection.workspaceId||binding.serviceId!==connection.serviceId)reject('OWNER_HOST_SCOPE','Owner Host registration belongs to another installed service',403);
      args.push('--owner-config-ref',ref,'--owner-config-digest',legacy.ownerConfigDigest);
    }
    servers.evopilot_runtime_legacy={type:'stdio',command:nodeExecutable,args};
  }
  files.set('.mcp.json',Buffer.from(canonical({mcpServers:servers})+'\n'));
  return{name:PLUGIN_NAME,version:string(manifest.version),files,transport:'streamable-http',credentialEmbedded:false};
}
