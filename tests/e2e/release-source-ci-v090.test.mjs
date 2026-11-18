// Synthetic provider/archive integrity fixtures; never actual source CI or E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parse as parseYaml} from 'yaml';
import {inspectSourceCiRecords} from '../../dist/release/source-ci.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
function zip(files){
 const local=[],central=[];let offset=0;
 for(const [key,value] of files){const name=Buffer.from(key),bytes=Buffer.from(value),crc=crc32(bytes),l=Buffer.alloc(30),c=Buffer.alloc(46);
  l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc,14);l.writeUInt32LE(bytes.length,18);l.writeUInt32LE(bytes.length,22);l.writeUInt16LE(name.length,26);
  c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE((0o100644<<16)>>>0,38);c.writeUInt32LE(offset,42);
  local.push(l,name,bytes);central.push(c,name);offset+=30+name.length+bytes.length;
 }
 const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);
}
function fixture(changeFiles=()=>{}){
 const sourceCommit='a'.repeat(40),archive=Buffer.from('Synthetic standalone distribution bytes; never install this fixture.'),manifest=Buffer.from(JSON.stringify({schema:'runtime-standalone-distribution/v1',version:'0.9.0',archiveDigest:sha(archive),files:{'package.json':{type:'file',sha256:sha('{}'),bytes:2,mode:420}}}));
 const files=new Map([['evopilot-runtime-0.9.0-darwin-arm64.tar.gz',archive],['evopilot-next-runtime-0.9.0.tgz',Buffer.from('synthetic SDK')],['distribution-manifest.json',manifest],['source-revision.txt',Buffer.from(sourceCommit+'\n')],['runtime-dependency-lock.json',Buffer.from(JSON.stringify({name:'@evopilot-next/runtime',version:'0.9.0',lockfileVersion:3}))]]);
 files.set('SHA256SUMS',Buffer.from([...files].map(([n,b])=>sha(b)+'  '+n+'\n').join('')));changeFiles(files);
 const artifactZip=zip(files),artifactDigest=sha(artifactZip),id=23,runId=12,repo={id:1416265295,full_name:'yeliang-wang/evopilot-runtime'},name=`evopilot-runtime-${sourceCommit}-package`;
 const run={id:runId,run_attempt:1,repository:repo,head_repository:repo,head_sha:sourceCommit,path:'.github/workflows/ci.yml',status:'completed',conclusion:'success',event:'workflow_dispatch'};
 const required=['Verify the declared source-test platform','Run npm ci --ignore-scripts','Run npm run build','Run npm run check','Run npm test','Pack exact candidate (not a Release)','Retain independently built candidate package'];
 const jobs={total_count:1,jobs:[{id:45,name:'source',run_id:runId,run_attempt:1,head_sha:sourceCommit,status:'completed',conclusion:'success',labels:['macos-15'],steps:required.map(name=>({name,status:'completed',conclusion:'success'}))}]};
 const artifact={id,name,size_in_bytes:artifactZip.length,url:`https://api.github.com/repos/${repo.full_name}/actions/artifacts/${id}`,archive_download_url:`https://api.github.com/repos/${repo.full_name}/actions/artifacts/${id}/zip`,expired:false,digest:'sha256:'+artifactDigest,expires_at:new Date(Date.now()+86400000).toISOString(),workflow_run:{id:runId,head_sha:sourceCommit,repository_id:repo.id,head_repository_id:repo.id}};
 const jobLog='##[group]Run npm test\n##[endgroup]\nℹ tests 7\nℹ pass 7\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n##[group]Run package\nSHA256 digest of uploaded artifact zip is '+artifactDigest+'\nArtifact '+name+'.zip successfully finalized. Artifact ID '+id+'\n';
 const input={sourceCommit,manifestDigest:sha(manifest),archiveDigest:sha(archive),artifactDigest,run,jobs,artifact,artifactZip,jobLog};return{input,audit:()=>inspectSourceCiRecords(input,AbortSignal.timeout(5000))};
}
test('source/job/attempt/upload/download and each distribution asset bind one exact candidate without granting release',async()=>{
 const f=fixture(),r=await f.audit();assert.equal(r.recordIntegrity,'VERIFIED');assert.equal(r.counts.tests,7);assert.equal(r.counts.skipped,0);assert.equal(Object.keys(r.files).length,6);assert.equal(r.releaseAuthorized,false);assert.equal(r.productAcceptance,'NOT_EVALUATED');assert.equal(r.providerAuthentication,'CALLER_MUST_RETAIN_AUTHENTICATED_READS');
 const timestamp='2026-11-04T05:56:08.7244370Z ';f.input.jobLog=f.input.jobLog.trimEnd().split('\n').map(s=>timestamp+s).join('\n')+'\n';assert.equal((await f.audit()).jobId,45);
});
test('foreign source, failed/skipped jobs, missing steps and stale attempts cannot qualify',async()=>{
 for(const mutate of [v=>v.run.head_sha='b'.repeat(40),v=>v.run.repository={id:7,full_name:'foreign/repo'},v=>v.run.head_repository={id:7},v=>v.run.conclusion='failure',v=>v.run.path='.github/workflows/other.yml',v=>v.jobs.total_count=2,v=>v.jobs.jobs[0].run_attempt=2,v=>v.jobs.jobs[0].steps[4].conclusion='skipped',v=>v.jobs.jobs[0].steps.splice(4,1),v=>v.jobs.jobs[0].steps.reverse(),v=>v.jobs.jobs[0].labels=['ubuntu-latest']]){const f=fixture();mutate(f.input);await assert.rejects(f.audit,/SOURCE_CI_EVIDENCE/);}
});
test('zero, skipped, failed or duplicate counts and a different upload cannot borrow a successful run',async()=>{
 for(const mutate of [s=>s.replace('tests 7','tests 0'),s=>s.replace('pass 7','pass 6'),s=>s.replace('fail 0','fail 1'),s=>s.replace('skipped 0','skipped 1'),s=>s.replace('todo 0','todo 1'),s=>s.replace('ℹ tests 7','ℹ tests 7\nℹ tests 7'),s=>s.replace('Artifact ID 23','Artifact ID 99'),s=>s.replace('SHA256 digest','wrong digest'),s=>s.replace('Run npm test','Run selected test')]){const f=fixture();f.input.jobLog=mutate(f.input.jobLog);await assert.rejects(f.audit,/SOURCE_CI_EVIDENCE/);}
});
test('original metadata, archive bytes, inner checksum allowlist and accepted package pins are independent checks',async()=>{
 for(const mutate of [v=>v.artifact.expired=true,v=>v.artifact.expires_at='2020-01-01T00:00:00Z',v=>v.artifact.workflow_run.id=99,v=>v.artifact.workflow_run.head_repository_id=5,v=>v.artifact.archive_download_url='https://example.invalid/archive',v=>v.artifact.size_in_bytes++,v=>v.artifactZip[0]=0,v=>v.manifestDigest='b'.repeat(64),v=>v.archiveDigest='b'.repeat(64)]){const f=fixture();mutate(f.input);await assert.rejects(f.audit);}
 for(const mutate of [m=>m.delete('runtime-dependency-lock.json'),m=>m.set('extra.txt',Buffer.from('extra')),m=>m.set('source-revision.txt',Buffer.from('b'.repeat(40)+'\n')),m=>m.set('SHA256SUMS',Buffer.from('')),m=>m.set('evopilot-next-runtime-0.9.0.tgz',Buffer.from('changed SDK'))])await assert.rejects(fixture(mutate).audit);
});

const currentRequired=['Verify the declared source-test platform','Run npm ci --ignore-scripts','Run npm run build','Check scoped correction code','Validate workflows with pinned actionlint','Verify source contracts','Run source regressions including generated properties','Pack exact candidate (not a Release)','Retain independently built candidate package'];
const inactiveLc20=['Resolve the original protected LC20 producer','Check the original implementation source','Execute the original complete LC20 case','Observe the original LC20 input inventory','Retain the exact original Runtime CI archive'];
const sourceCommands=['npm ci --ignore-scripts','npm run build','npm run lint:correction','npm run lint:workflows','npm run check'];
function currentFixture(){
 const f=fixture();f.input.run.display_title='evopilot:SOURCE_CHECKS:none';
 const names=['Set up job','Run actions/checkout@v4','Run actions/setup-node@v4',...currentRequired,...inactiveLc20,'Post Run actions/setup-node@v4','Post Run actions/checkout@v4','Complete job'];
 // The provider's post-action numbers are nonconsecutive; names and execution
 // order bind the workflow, not an invented consecutive-number requirement.
 f.input.jobs.jobs[0].steps=names.map((name,i)=>({name,number:i<17?i+1:i+16,status:'completed',conclusion:inactiveLc20.includes(name)?'skipped':'success'}));
 f.input.jobLog=sourceCommands.map(command=>'##[group]Run '+command+'\n##[endgroup]\n').join('')+f.input.jobLog;
 return f;
}
test('current source profile matches the checked-in workflow and only its five inapplicable LC20 steps',()=>{
 const workflow=parseYaml(readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8'));
 assert.equal(workflow['run-name'],'evopilot:${{ inputs.runtime_request_id }}:${{ inputs.runtime_input_digest }}');
 const steps=workflow.jobs.source.steps.slice(2);
 assert.deepEqual(steps.map(s=>s.name??'Run '+s.run),[...currentRequired,...inactiveLc20]);
 assert.deepEqual(steps.slice(1,7).map(s=>s.run),[...sourceCommands,'npm test']);
 assert.equal(steps[9].if,"${{ github.event_name == 'workflow_dispatch' && inputs.runtime_request_id != '' && inputs.runtime_request_id != 'SOURCE_CHECKS' }}");
 assert.deepEqual(steps.slice(10).map(s=>s.if),["${{ steps.lc20.outputs.mode == 'IMPLEMENTATION' }}","${{ steps.lc20.outputs.mode == 'EXECUTE' }}","${{ steps.lc20.outputs.mode == 'INVENTORY' }}","${{ success() && steps.lc20.outputs.mode != '' }}"]);
});
test('current native source job shape qualifies with command-named logs and exact inactive LC20 steps',async()=>{
 for(const event of ['workflow_dispatch','push','pull_request']){
  const f=currentFixture();f.input.run.event=event;if(event!=='workflow_dispatch')f.input.run.display_title='evopilot::';const r=await f.audit();assert.equal(r.recordIntegrity,'VERIFIED');assert.equal(r.counts.tests,7);assert.equal(r.counts.skipped,0);assert.equal(r.releaseAuthorized,false);assert.equal(r.productAcceptance,'NOT_EVALUATED');
 }
 const f=currentFixture();f.input.run.display_title='evopilot::none';assert.equal((await f.audit()).recordIntegrity,'VERIFIED');
});
test('every current required check remains mandatory, successful, completed and uniquely ordered',async()=>{
 for(const name of currentRequired)for(const change of ['skipped','failure','cancelled','pending','missing','duplicate']){
  const f=currentFixture(),steps=f.input.jobs.jobs[0].steps,index=steps.findIndex(s=>s.name===name);
  if(change==='missing')steps.splice(index,1);else if(change==='duplicate')steps.push({...steps[index]});else if(change==='pending')steps[index].status='in_progress';else steps[index].conclusion=change;
  await assert.rejects(f.audit,/SOURCE_CI_EVIDENCE/,name+': '+change);
 }
 const f=currentFixture();[f.input.jobs.jobs[0].steps[6],f.input.jobs.jobs[0].steps[7]]=[f.input.jobs.jobs[0].steps[7],f.input.jobs.jobs[0].steps[6]];await assert.rejects(f.audit,/step order/);
});
test('no other skipped step or active, missing, duplicated or reordered LC20 step qualifies',async()=>{
 for(const name of inactiveLc20)for(const change of ['success','failure','cancelled','pending','missing','duplicate','renamed']){
  const f=currentFixture(),steps=f.input.jobs.jobs[0].steps,index=steps.findIndex(s=>s.name===name);
  if(change==='missing')steps.splice(index,1);else if(change==='duplicate')steps.push({...steps[index]});else if(change==='renamed')steps[index].name+=' unexpected';else if(change==='pending')steps[index].status='in_progress';else steps[index].conclusion=change;
  await assert.rejects(f.audit,/SOURCE_CI_EVIDENCE/,name+': '+change);
 }
 for(const mutate of [s=>s.push({name:'Unrelated conditional step',status:'completed',conclusion:'skipped'}),s=>s[0].conclusion='skipped',s=>s.unshift(s.splice(12,1)[0])]){
  const f=currentFixture();mutate(f.input.jobs.jobs[0].steps);await assert.rejects(f.audit,/SOURCE_CI_EVIDENCE/);
 }
});
test('LC20 request mode and current-to-historical shape substitution cannot masquerade as Source checks',async()=>{
 for(const title of [undefined,'Source checks','evopilot:request-1:'+('a'.repeat(64)),'evopilot:SOURCE_CHECKS_OTHER:none']){
  const f=currentFixture();f.input.run.display_title=title;await assert.rejects(f.audit,/Source checks mode/);
 }
 for(const title of ['evopilot:SOURCE_CHECKS:none','evopilot:request-1:none']){
  const f=fixture();f.input.run.display_title=title;await assert.rejects(f.audit,/SOURCE_CI_EVIDENCE/);
 }
 const f=currentFixture();f.input.jobs.jobs[0].labels=['runtime-lc20-isolated'];await assert.rejects(f.audit,/frozen macOS runner/);
 const mixed=currentFixture();mixed.input.jobs.jobs[0].steps.push({name:'Run npm test',status:'completed',conclusion:'success'});await assert.rejects(mixed.audit,/Mixed historical/);
});
test('current command logs keep original names, complete source counts and exact uploaded artifact binding',async()=>{
 for(const command of [...sourceCommands,'npm test']){
  for(const duplicate of [false,true]){
   const f=currentFixture(),marker='##[group]Run '+command+'\n';f.input.jobLog=f.input.jobLog.replace(marker,duplicate?marker+marker:'##[group]Different command\n');await assert.rejects(f.audit,/source command log/);
  }
 }
 for(const change of [s=>s.replace('Run npm run build','Run TEMP').replace('Run npm run lint:correction','Run npm run build').replace('Run TEMP','Run npm run lint:correction'),s=>s.replace('tests 7','tests 0'),s=>s.replace('fail 0','fail 1'),s=>s.replace('skipped 0','skipped 1'),s=>s.replace('Artifact ID 23','Artifact ID 99')]){
  const f=currentFixture();f.input.jobLog=change(f.input.jobLog);await assert.rejects(f.audit,/SOURCE_CI_EVIDENCE/);
 }
});

test('current push and pull_request require the native empty-input title while historical source records remain valid',async()=>{
 for(const event of ['push','pull_request']){
  for(const title of [undefined,'Source checks','evopilot:SOURCE_CHECKS:none','evopilot:lc20-request:'+('a'.repeat(64)),'evopilot::none','evopilot:SOURCE_CHECKS:']){
   const f=currentFixture();f.input.run.event=event;f.input.run.display_title=title;await assert.rejects(f.audit,/Source checks mode/);
  }
  const historical=fixture();historical.input.run.event=event;historical.input.run.display_title='Historical source checks';assert.equal((await historical.audit()).recordIntegrity,'VERIFIED');
 }
});
