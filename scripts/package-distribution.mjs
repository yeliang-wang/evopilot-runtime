import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdirSync,readFileSync,realpathSync,unlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildStandaloneDistribution} from '../dist/installation/distribution.js';

const repo=realpathSync(fileURLToPath(new URL('../',import.meta.url)));
function command(name,args,cwd=repo){
 const r=spawnSync(name,args,{cwd,encoding:'utf8',maxBuffer:16*1024*1024});
 assert.ifError(r.error);assert.equal(r.status,0,`${name} failed; retain the original staging directory: ${r.stderr}`);return r.stdout;
}
try{
 const profile=process.argv[3];
 assert(process.argv.length===3 || (process.argv.length===4 && profile==='--limited-preview'),'Provide one new output directory and optional --limited-preview');
 assert.equal(command('git',['status','--porcelain']).trim(),'','Candidate must use clean exact committed source');
 const output=resolve(process.argv[2]),staging=output+'.staging';mkdirSync(staging,{mode:0o700});
 const sourceCommit=command('git',['rev-parse','HEAD']).trim();
 const records=JSON.parse(command('npm',['pack','--ignore-scripts','--json','--pack-destination',staging]));
 assert.equal(records.length,1);const pack=records[0],pkg=JSON.parse(readFileSync(join(repo,'package.json')));
 assert.equal(pack.name,pkg.name);assert.equal(pack.version,pkg.version);assert.equal(pack.filename,`evopilot-next-runtime-${pkg.version}.tgz`);
 let npmArchive=join(staging,pack.filename);
 const bytes=readFileSync(npmArchive);
 assert.equal(pack.integrity,'sha512-'+createHash('sha512').update(bytes).digest('base64'));
 const paths=command('/usr/bin/tar',['-tzf',npmArchive]).trimEnd().split('\n');
 assert.deepEqual([...paths].sort(),pack.files.map(f=>'package/'+f.path).sort());
 for(const name of paths)assert(name.startsWith('package/')&&!name.includes('\\')&&!/[\x00-\x1f\x7f]/.test(name)&&name.split('/').every(p=>p&&p!=='.'&&p!=='..'));
 command('/usr/bin/tar',['-xzf',npmArchive,'-C',staging]);
 const packageRoot=join(staging,'package');
 if(profile==='--limited-preview'){
   const previewPackage={
     ...pkg, evopilotDistributionProfile:'limited-preview', exports:{},
     bin:{'evopilot-runtime':pkg.bin['evopilot-runtime'],'evopilot-runtime-install':pkg.bin['evopilot-runtime-install']}
   };
   writeFileSync(join(packageRoot,'package.json'),JSON.stringify(previewPackage,null,2)+'\n');
   // Retire the direct legacy command as well as the package's public bin alias.
   for(const file of ['dist/cli.js','dist/cli.js.map','dist/cli.d.ts','src/cli.ts'])unlinkSync(join(packageRoot,file));
   const pluginPath=join(packageRoot,'plugins/codex/.codex-plugin/plugin.json');
   const plugin=JSON.parse(readFileSync(pluginPath,'utf8'));
   plugin.description='Limited local EvoPilot Runtime Preview for project lifecycle drafts and read-only observation.';
   plugin.interface.shortDescription='Local lifecycle drafts and read-only monitoring';
   writeFileSync(pluginPath,JSON.stringify(plugin,null,2)+'\n');
   const skillPath=join(packageRoot,'plugins/codex/skills/evopilot-runtime-expert/SKILL.md');
   writeFileSync(skillPath,[
     '---','name: evopilot-runtime-expert','description: Inspect local lifecycle definitions and save isolated drafts in the limited Runtime Preview.','---','',
     '# Runtime limited Preview','',
     'Use the operations advertised by this service. Read the project, inspect the Publisher Base and validate YAML before saving a draft. Monitor state is read-only. The limited package is installed without registering a Codex plugin.',''
   ].join('\n'));
   const previewArchiveDir=join(staging,'limited-preview');mkdirSync(previewArchiveDir,{mode:0o700});
   const [preview]=JSON.parse(command('npm',['pack','--ignore-scripts','--json','--pack-destination',previewArchiveDir],packageRoot));
   assert.equal(preview.filename,pack.filename);
   npmArchive=join(previewArchiveDir,preview.filename);
   assert.equal(preview.integrity,'sha512-'+createHash('sha512').update(readFileSync(npmArchive)).digest('base64'));
 }
 copyFileSync(join(repo,'package-lock.json'),join(packageRoot,'package-lock.json'));
 command('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],packageRoot);
 command('npm',['ls','--omit=dev','--all','--json'],packageRoot);
 assert.equal(command('git',['rev-parse','HEAD']).trim(),sourceCommit,'Source moved during preparation');
 assert.equal(command('git',['status','--porcelain']).trim(),'','Source changed during preparation');
 const result=buildStandaloneDistribution({packageRoot,npmArchive,outputDirectory:output,sourceCommit});
 writeFileSync(join(staging,'build-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify(result));
}catch(error){console.error(error.message);process.exitCode=1;}
