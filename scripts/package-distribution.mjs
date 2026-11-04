import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
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
 assert.equal(process.argv.length,3,'Provide one new private output directory');
 assert.equal(command('git',['status','--porcelain']).trim(),'','Candidate must use clean exact committed source');
 const output=resolve(process.argv[2]),staging=output+'.staging';mkdirSync(staging,{mode:0o700});
 const sourceCommit=command('git',['rev-parse','HEAD']).trim();
 const records=JSON.parse(command('npm',['pack','--ignore-scripts','--json','--pack-destination',staging]));
 assert.equal(records.length,1);const pack=records[0],pkg=JSON.parse(readFileSync(join(repo,'package.json')));
 assert.equal(pack.name,pkg.name);assert.equal(pack.version,pkg.version);assert.equal(pack.filename,`evopilot-next-runtime-${pkg.version}.tgz`);
 const npmArchive=join(staging,pack.filename),bytes=readFileSync(npmArchive);
 assert.equal(pack.integrity,'sha512-'+createHash('sha512').update(bytes).digest('base64'));
 const paths=command('/usr/bin/tar',['-tzf',npmArchive]).trimEnd().split('\n');
 assert.deepEqual([...paths].sort(),pack.files.map(f=>'package/'+f.path).sort());
 for(const name of paths)assert(name.startsWith('package/')&&!name.includes('\\')&&!/[\x00-\x1f\x7f]/.test(name)&&name.split('/').every(p=>p&&p!=='.'&&p!=='..'));
 command('/usr/bin/tar',['-xzf',npmArchive,'-C',staging]);
 const packageRoot=join(staging,'package');copyFileSync(join(repo,'package-lock.json'),join(packageRoot,'package-lock.json'));
 command('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],packageRoot);
 command('npm',['ls','--omit=dev','--all','--json'],packageRoot);
 assert.equal(command('git',['rev-parse','HEAD']).trim(),sourceCommit,'Source moved during preparation');
 assert.equal(command('git',['status','--porcelain']).trim(),'','Source changed during preparation');
 const result=buildStandaloneDistribution({packageRoot,npmArchive,outputDirectory:output,sourceCommit});
 writeFileSync(join(staging,'build-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify(result));
}catch(error){console.error(error.message);process.exitCode=1;}
