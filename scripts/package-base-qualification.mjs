// Build a named private predecessor from exact committed publisher source.
// This never patches a selected final candidate or an installed service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const repo=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url))),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const profilePath='tests/fixtures/base-upgrade-v090/qualification-profile.json';
const write=(ref,bytes)=>fs.writeFileSync(ref,typeof bytes==='string'||Buffer.isBuffer(bytes)?bytes:JSON.stringify(bytes,null,2)+'\n',{mode:0o600,flag:'wx'});
function command(executable,args,cwd,logRef){
 const result=spawnSync(executable,args,{cwd,encoding:null,timeout:180000,maxBuffer:67108864,shell:false});
 if(logRef)write(logRef,{executable,args,exitCode:result.status,signal:result.signal,stdout:result.stdout?.toString()??'',stderr:result.stderr?.toString()??''});
 assert(!result.error&&result.status===0&&result.signal===null,'Qualification preparation failed; inspect the retained command log before a new attempt');return result.stdout;
}
try{
 assert.equal(process.argv.length,3,'Provide one new private qualification output directory');
 assert.equal(process.version,'v24.14.0');assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
 const git=args=>command('/usr/bin/git',args,repo),commit=git(['rev-parse','HEAD']).toString().trim();assert(/^[a-f0-9]{40}$/.test(commit));assert.equal(git(['status','--porcelain']).length,0,'Use clean committed source');
 const output=path.resolve(process.argv[2]),parent=path.dirname(output);assert.equal(fs.realpathSync(parent),parent);assert(!fs.existsSync(output));
 assert(output!==repo&&!output.startsWith(repo+path.sep),'Qualification output must be separate from the source checkout');
 const staging=output+'.staging';fs.mkdirSync(staging,{mode:0o700});const checkout=path.join(staging,'source');fs.mkdirSync(checkout,{mode:0o700});
 const sourceEntries=git(['ls-tree','-r','-z',commit]).toString().split('\0').filter(Boolean);
 assert(sourceEntries.length>0&&sourceEntries.length<20000);
 for(const item of sourceEntries)assert(/^(100644|100755) blob [a-f0-9]{40}\t/.test(item),'Qualification source must contain regular tracked files, not links or submodules');
 const archive=git(['archive','--format=tar',commit]);assert(archive.length<=67108864);const sourceArchive=path.join(staging,'committed-source.tar');write(sourceArchive,archive);
 const names=command('/usr/bin/tar',['-tf',sourceArchive],staging).toString().trimEnd().split('\n');assert(names.length>0&&names.length<20000);
 for(const name of names){assert(!path.isAbsolute(name)&&!/[\\\x00-\x1f\x7f]/.test(name));assert(name.replace(/\/$/,'').split('/').every(part=>part&&part!=='.'&&part!=='..'));}
 command('/usr/bin/tar',['-xf',sourceArchive,'-C',checkout],staging);
 const profileBytes=fs.readFileSync(path.join(checkout,profilePath)),profile=JSON.parse(profileBytes);
 assert.deepEqual(profile,JSON.parse(fs.readFileSync(path.join(repo,profilePath))));
 assert.equal(profile.schema,'runtime-base-qualification-profile/v1');assert.equal(profile.classification,'PRIVATE_EX10_QUALIFICATION_ONLY');assert.equal(profile.officialRelease,false);
 assert.equal(profile.sourceVersion,'0.9.0');assert.equal(profile.qualificationVersion,'0.9.0-ex10-a');assert.equal(profile.baseVersion,profile.qualificationVersion);
 const changed=[];
 function change(relative,transform){const ref=path.join(checkout,relative);assert.equal(fs.realpathSync(ref),ref);const before=fs.readFileSync(ref),after=Buffer.from(transform(before.toString()));assert(!before.equals(after));fs.writeFileSync(ref,after);changed.push({path:relative,beforeSha256:sha(before),afterSha256:sha(after)});}
 const basePath='lifecycle/base/software-release-0.9.0.json',manifestPath='lifecycle/base/manifest.json',oldManifest=fs.readFileSync(path.join(checkout,manifestPath));
 const manifest=JSON.parse(oldManifest),entry=manifest.bases[0];assert.equal(manifest.bases.length,1);assert.equal(entry.version,profile.sourceVersion);assert.equal(entry.file,path.basename(basePath));
 assert.equal(entry.digest,'sha256:'+sha(fs.readFileSync(path.join(checkout,basePath))));
 change(basePath,text=>{const base=JSON.parse(text);assert.equal(base.version,profile.sourceVersion);assert.equal(base.fields.length,84);
  const schema=base.fields.find(field=>field.path==='schema');assert.equal(schema.rules.fixed,'runtime-project-lifecycle/v1');schema.rules.fixed=profile.projectSchema;
  const removed=base.fields.filter(field=>field.path===profile.removedRequiredField);assert.equal(removed.length,1);assert.equal(removed[0].required,true);base.fields=base.fields.filter(field=>field.path!==profile.removedRequiredField);
  const constraint=base.fields.find(field=>field.path===profile.relaxedConstraint.path);assert.equal(constraint.rules.maximum,profile.relaxedConstraint.originalMaximum);constraint.rules.maximum=profile.relaxedConstraint.maximum;
  const {id,...slot}=profile.addedSlot;assert(!base.slots[id]);base.slots[id]=slot;base.version=profile.baseVersion;base.schema=profile.baseSchema;return JSON.stringify(base,null,2)+'\n';});
 change(manifestPath,text=>{const value=JSON.parse(text),pin=value.bases[0];pin.version=profile.baseVersion;pin.schemaVersion=profile.baseSchema;pin.digest='sha256:'+sha(fs.readFileSync(path.join(checkout,basePath)));return JSON.stringify(value,null,2)+'\n';});
 const manifestDigest=sha(fs.readFileSync(path.join(checkout,manifestPath)));
 change('src/lifecycle/base.ts',text=>{const pattern=/const MANIFEST_DIGEST\s*=\s*'([a-f0-9]{64})';/g,found=[...text.matchAll(pattern)];assert.equal(found.length,1);assert.equal(found[0][1],sha(oldManifest));return text.replace(pattern,"const MANIFEST_DIGEST = '"+manifestDigest+"';");});
 change('src/index.ts',text=>{const from="export const VERSION = '"+profile.sourceVersion+"';";assert.equal(text.split(from).length,2);return text.replace(from,"export const VERSION = '"+profile.qualificationVersion+"';");});
 change('package.json',text=>{const value=JSON.parse(text);assert.equal(value.name,'@evopilot-next/runtime');assert.equal(value.version,profile.sourceVersion);value.version=profile.qualificationVersion;value.files.push('QUALIFICATION.json');return JSON.stringify(value,null,2)+'\n';});
 change('package-lock.json',text=>{const value=JSON.parse(text);assert.equal(value.version,profile.sourceVersion);assert.equal(value.packages[''].version,profile.sourceVersion);value.version=profile.qualificationVersion;value.packages[''].version=profile.qualificationVersion;return JSON.stringify(value,null,2)+'\n';});
 change('plugins/codex/.codex-plugin/plugin.json',text=>{const value=JSON.parse(text);assert.equal(value.version,profile.sourceVersion);value.version=profile.qualificationVersion;return JSON.stringify(value,null,2)+'\n';});
 const qualification={schema:'runtime-base-qualification-build/v1',classification:profile.classification,officialRelease:false,sourceCommit:commit,sourceArchiveSha256:sha(archive),profileSha256:sha(profileBytes),qualificationVersion:profile.qualificationVersion,basePin:JSON.parse(fs.readFileSync(path.join(checkout,manifestPath))).bases[0],changedSource:changed,dailyInstallationAllowed:false,releaseAuthorized:false};
 write(path.join(checkout,'QUALIFICATION.json'),qualification);
 // This byte-pinned metadata belongs to the private test package, with the
 // same non-executable mode as its standalone inventory. The enclosing test
 // tree and the separate operator preparation records remain private.
 fs.chmodSync(path.join(checkout,'QUALIFICATION.json'),0o644);
 write(path.join(staging,'qualification-plan.json'),qualification);
 command('npm',['ci','--offline','--ignore-scripts','--no-audit','--no-fund','--userconfig=/dev/null'],checkout,path.join(staging,'dependencies.json'));
 command(process.execPath,['scripts/build.mjs'],checkout,path.join(staging,'build.json'));
 const packResult=command('npm',['pack','--ignore-scripts','--json','--pack-destination',staging,'--userconfig=/dev/null'],checkout,path.join(staging,'pack.json')),records=JSON.parse(packResult.toString());assert.equal(records.length,1);
 const packed=records[0],name='evopilot-next-runtime-'+profile.qualificationVersion+'.tgz';assert.equal(packed.filename,name);assert.equal(packed.version,profile.qualificationVersion);
 const npmArchive=path.join(staging,name),npmBytes=fs.readFileSync(npmArchive);assert.equal(packed.integrity,'sha512-'+createHash('sha512').update(npmBytes).digest('base64'));
 const packageDir=path.join(staging,'unpacked');fs.mkdirSync(packageDir,{mode:0o700});const packageNames=command('/usr/bin/tar',['-tzf',npmArchive],staging).toString().trimEnd().split('\n');assert.deepEqual(packageNames.sort(),packed.files.map(f=>'package/'+f.path).sort());
 for(const name of packageNames)assert(name.startsWith('package/')&&!/[\\\x00-\x1f\x7f]/.test(name)&&name.split('/').every(part=>part&&part!=='.'&&part!=='..'));
 command('/usr/bin/tar',['-xzf',npmArchive,'-C',packageDir],staging);const packageRoot=path.join(packageDir,'package');fs.copyFileSync(path.join(checkout,'package-lock.json'),path.join(packageRoot,'package-lock.json'));
 command('npm',['ci','--omit=dev','--offline','--ignore-scripts','--no-audit','--no-fund','--userconfig=/dev/null'],packageRoot,path.join(staging,'production-dependencies.json'));
 const builder=await import(pathToFileURL(path.join(checkout,'dist/installation/distribution.js')).href),result=builder.buildStandaloneDistribution({packageRoot,npmArchive,outputDirectory:output,sourceCommit:commit});
 write(path.join(output,'QUALIFICATION.json'),qualification);assert.equal(git(['rev-parse','HEAD']).toString().trim(),commit);assert.equal(git(['status','--porcelain']).length,0,'Original source changed during qualification build');
 write(path.join(staging,'result.json'),{...result,packageRoot,qualification,productAcceptance:'NOT_EVALUATED'});console.log(JSON.stringify({directory:output,packageRoot,version:profile.qualificationVersion,officialRelease:false,releaseAuthorized:false}));
}catch(error){console.error(error instanceof Error?error.message:'Qualification preparation failed');process.exitCode=1;}
