/** Frozen original project template, owned and verified by independent Runtime.
 * Template version is not the Runtime release version or Lifecycle activation. */
import path from 'node:path';
import {codeRoot,readRegular,digest,fail} from './files.js';
export interface ProjectTemplateFile {relative:string;bytes:Buffer;sha256:string;}
const templateRoot=path.join(codeRoot,'provenance/project-template-v02');
const manifestDigest="8c5f6f1ae4e93e2153547c5ee222671ba2fd632707e9fd341f28846cff873235";
export function inspectProjectTemplate():{version:'0.2.0';digest:string;files:ProjectTemplateFile[]} {
  const bytes=readRegular(path.join(templateRoot,'manifest.json'));
  if(digest(bytes)!==manifestDigest)fail('TEMPLATE_INCOMPLETE');
  const manifest=JSON.parse(bytes.toString()) as {files:Record<string,string>};
  const files=Object.entries(manifest.files).sort(([a],[b])=>a.localeCompare(b,'en')).map(([relative,sha256])=>{
    const bytes=readRegular(path.join(templateRoot,relative));
    if(digest(bytes)!==sha256)fail('TEMPLATE_INCOMPLETE');
    return{relative,bytes,sha256};
  });
  return{version:'0.2.0',digest:manifestDigest,files};
}
