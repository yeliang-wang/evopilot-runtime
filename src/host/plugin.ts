import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {canonical,exact,record,reject,string} from '../server/errors.js';
import {readHostConnection} from '../server/security.js';

export const PLUGIN_NAME='evopilot-runtime';
export const PLUGIN_STATIC_FILES=[
  '.codex-plugin/plugin.json','skills/evopilot-runtime-expert/SKILL.md',
  'skills/evopilot-runtime-expert/agents/openai.yaml',
  ...['configuration','execution','recovery'].map(n=>'skills/evopilot-runtime-expert/references/'+n+'.md'),
] as const;
export interface PluginMaterial {name:typeof PLUGIN_NAME;version:string;files:ReadonlyMap<string,Buffer>;transport:'streamable-http';credentialEmbedded:false;}
// Codex's helper field is a command string, not argv. Quote each fixed argument
// independently; a filesystem path must never become shell syntax.
export const quoteHelperArgument=(value:string):string=>"'"+value.replaceAll("'","'\"'\"'")+"'";
/** Prepare a single local plugin from this Runtime package. Installation owns
 * writing/registration; material generation alone never enables a Host. */
export function runtimePluginMaterial(packageRoot:string,connectionRef:string,nodeExecutable:string):PluginMaterial{
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
  files.set('.mcp.json',Buffer.from(canonical({mcpServers:{evopilot_runtime:{type:'http',url:connection.origin+'/mcp',http_headers_helper:[nodeExecutable,helper,'--connection-ref',connectionRef].map(quoteHelperArgument).join(' ')}}})+'\n'));
  return{name:PLUGIN_NAME,version:string(manifest.version),files,transport:'streamable-http',credentialEmbedded:false};
}
