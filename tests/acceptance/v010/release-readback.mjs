import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assetNames,repository,repositoryId,tag,verifyV010Files,version} from '../../../scripts/release-gate-v010.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const api = 'https://api.github.com/repos/'+repository;
const downloads = 'https://github.com/'+repository+'/releases/download/'+tag+'/';
const downloadHosts = new Set(['release-assets.githubusercontent.com','objects.githubusercontent.com']);

async function bytes(response,max) {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(()=>{});
    assert.fail('GitHub anonymous readback did not succeed');
  }
  const reader=response.body.getReader();
  const chunks=[];
  let size=0;
  try {
    for (;;) {
      const item=await reader.read();
      if (item.done) break;
      size+=item.value.byteLength;
      if (size>max) {
        void reader.cancel().catch(()=>{});
        assert.fail('GitHub response exceeds the pinned readback size');
      }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks,size);
}

/** Read back an exact public Preview as an anonymous client. The returned
 * files are still uninstalled and prove only the public-readback case. */
export async function readBackV010Release(review,{signal=AbortSignal.timeout(120000),fetcher=fetch}={}) {
  const {reviewDigest,...reviewBody}=review;
  assert.equal(reviewDigest,'sha256:'+digest(JSON.stringify(reviewBody)));
  assert(review.schema==='runtime-v010-publication-review/v1' && review.repository===repository &&
    review.repositoryId===repositoryId && review.tag===tag && review.version===version &&
    review.prerelease===true && revision.test(review.sourceCommit));
  assert.deepEqual(Object.keys(review.files).sort(),[...assetNames].sort());
  for (const name of assetNames) {
    const pin=review.files[name];
    assert(hash.test(pin.sha256) && Number.isSafeInteger(pin.bytes) && pin.bytes>0 && pin.bytes<=256*1024*1024);
  }
  const readJson=async endpoint=>JSON.parse((await bytes(await fetcher(endpoint,{
    headers:{accept:'application/vnd.github+json','x-github-api-version':'2026-03-10'},redirect:'error',signal,
  }),2*1024*1024)).toString('utf8'));

  const repo=await readJson(api);
  assert(repo.id===repositoryId && repo.full_name===repository && repo.private===false);
  const release=await readJson(api+'/releases/tags/'+tag);
  assert(release.tag_name===tag && release.draft===false && release.prerelease===true &&
    Number.isSafeInteger(release.id) && release.id>0 && typeof release.published_at==='string' &&
    Number.isFinite(Date.parse(release.published_at)));
  assert.equal(release.html_url,'https://github.com/'+repository+'/releases/tag/'+tag);
  const ref=await readJson(api+'/git/ref/tags/'+tag);
  assert.equal(ref.ref,'refs/tags/'+tag);
  let selected=ref.object;
  if (selected?.type==='tag') {
    assert(revision.test(selected.sha));
    const annotated=await readJson(api+'/git/tags/'+selected.sha);
    assert.equal(annotated.sha,selected.sha);
    assert.equal(annotated.tag,tag);
    selected=annotated.object;
  }
  assert(selected?.type==='commit' && selected.sha===review.sourceCommit,'Public tag must resolve to the accepted source');
  assert(Array.isArray(release.assets));
  assert.deepEqual(release.assets.map(asset=>asset.name).sort(),[...assetNames].sort());
  const files=new Map();
  for (const asset of release.assets) {
    const pin=review.files[asset.name], url=downloads+asset.name;
    assert(asset.state==='uploaded' && asset.size===pin.bytes && asset.browser_download_url===url);
    if (asset.digest!=null) assert.equal(asset.digest,'sha256:'+pin.sha256);
    let response=await fetcher(url,{redirect:'manual',signal});
    if (response.status===302 || response.status===307) {
      const destination=new URL(response.headers.get('location')??'');
      assert(destination.protocol==='https:' && downloadHosts.has(destination.hostname) &&
        !destination.port && !destination.username && !destination.password,'Unrecognized GitHub asset download host');
      response=await fetcher(destination,{redirect:'error',signal});
    }
    const file=await bytes(response,pin.bytes);
    assert.equal(file.length,pin.bytes);
    assert.equal(digest(file),pin.sha256);
    files.set(asset.name,file);
  }
  verifyV010Files(files,review.sourceCommit);
  return {files,report:{
    schema:'runtime-v010-public-readback/v1',source:fetcher===fetch?'GITHUB_PUBLIC':'FIXTURE',
    tag,repository,releaseId:release.id,releaseUrl:release.html_url,sourceCommit:review.sourceCommit,reviewDigest,
    assets:review.files,readAt:new Date().toISOString(),freshInstallation:'NOT_EVALUATED',
  }};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {
    const [reviewPath,destination]=process.argv.slice(2);
    assert.equal(process.argv.length,4,'Usage: node tests/acceptance/v010/release-readback.mjs PRIVATE_REVIEW NEW_PRIVATE_OUTPUT');
    assert(isAbsolute(reviewPath) && realpathSync(reviewPath)===reviewPath);
    const source=lstatSync(reviewPath);
    assert(source.isFile() && source.nlink===1 && source.uid===process.getuid() && (source.mode&0o077)===0 && source.size<1024*1024);
    assert(isAbsolute(destination) && resolve(destination)===destination && realpathSync(dirname(destination))===dirname(destination));
    const {files,report}=await readBackV010Release(JSON.parse(readFileSync(reviewPath,'utf8')));
    mkdirSync(destination,{mode:0o700});
    for (const [name,content] of files) writeFileSync(join(destination,name),content,{flag:'wx',mode:0o600});
    writeFileSync(join(destination,'public-readback.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify(report));
  } catch(error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
