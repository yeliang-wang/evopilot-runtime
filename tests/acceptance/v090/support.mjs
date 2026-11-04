// Candidate-bound acceptance infrastructure. No fixture binding provider, store
// mutation, implicit service startup or acceptance inference from source tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readRegular,canonicalPath} from '../../../dist/compat/project/files.js';
import {readHostConnection,hostHeaders} from '../../../dist/server/security.js';
import {inspectInstalledServiceSelection} from '../../../dist/installation/service-control.js';

export const repository=fileURLToPath(new URL('../../../',import.meta.url));
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=ref=>JSON.parse(fs.readFileSync(ref));
const keys=(v,required,optional=[])=>{
 assert(v&&typeof v==='object'&&!Array.isArray(v));
 assert(required.every(k=>Object.hasOwn(v,k)));assert(Object.keys(v).every(k=>required.includes(k)||optional.includes(k)));
};
const bounded=async response=>{
 assert(response.headers.get('content-type')?.startsWith('application/json'),'Expected JSON from the selected Runtime');
 const reader=response.body.getReader(),parts=[];let bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;assert(bytes<=262144,'Service response exceeds the frozen bound');parts.push(part.value);}}
 finally{reader.releaseLock();}
 return Buffer.concat(parts).toString('utf8');
};

export async function openScenario(scenario){
 const selectionRef=process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;
 assert(selectionRef,'Set EVOPILOT_V090_ACCEPTANCE_SELECTION to a protected, explicit isolated candidate selection');
 const selection=JSON.parse(readRegular(selectionRef,131072,true));
 keys(selection,['schema','installedRoot','expectedManifestDigest','connectionRef','workspaceId','projectId','runId','outputRoot','qualification'],['caseIds']);
 assert.equal(selection.schema,'runtime-v090-acceptance-selection/v1');assert(['DEVELOPMENT','FINAL_CANDIDATE'].includes(selection.qualification));
 assert(/^[a-z][a-z0-9-]{0,47}$/.test(selection.runId));assert(/^[a-f0-9]{64}$/.test(selection.expectedManifestDigest));
 const target=json(path.join(repository,'governance/target-v090.json'));
 const matrixRef=path.join(repository,'governance/parameter-matrix-v090.json'),matrixBytes=fs.readFileSync(matrixRef),matrix=JSON.parse(matrixBytes);
 assert.equal(sha(matrixBytes),target.implementationBindings['governance/parameter-matrix-v090.json']);assert.equal(matrix.count,664);
 const all=matrix.caseInstances.filter(c=>c.scenario===scenario);assert(all.length);
 const selectedIds=selection.caseIds??all.map(c=>c.caseInstanceId);
 assert(Array.isArray(selectedIds)&&selectedIds.length&&new Set(selectedIds).size===selectedIds.length);
 assert(selectedIds.every(id=>all.some(c=>c.caseInstanceId===id)),'The selection may not create or replace a frozen case');
 const cases=all.filter(c=>selectedIds.includes(c.caseInstanceId));
 const current=inspectInstalledServiceSelection(selection.installedRoot);
 const plan=json(path.join(selection.installedRoot,'installation-plan.json'));
 assert.equal(plan.distribution.manifestDigest,selection.expectedManifestDigest);
 const manifest=json(path.join(selection.installedRoot,'distribution-manifest.json'));
 const connection=readHostConnection(selection.connectionRef);
 assert.equal(selection.connectionRef,path.join(selection.installedRoot,'connection.json'));
 assert.equal(connection.workspaceId,selection.workspaceId);assert.equal(connection.projectId,selection.projectId);
 assert.equal(connection.serviceId,current.serviceId);assert.equal(connection.version,manifest.version);
 if(selection.qualification==='FINAL_CANDIDATE')assert.equal(manifest.version,'0.9.0','Development version cannot qualify the final release');
 canonicalPath(path.dirname(selection.outputRoot));assert(!fs.existsSync(selection.outputRoot),'Retain existing campaign evidence; do not overwrite a prior attempt');
 assert(!selection.outputRoot.startsWith(selection.installedRoot+path.sep));fs.mkdirSync(selection.outputRoot,{mode:0o700});
 const write=(name,value)=>fs.writeFileSync(path.join(selection.outputRoot,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
 const candidate={manifestDigest:selection.expectedManifestDigest,archiveDigest:manifest.archiveDigest,version:manifest.version,serviceId:connection.serviceId,workspaceId:selection.workspaceId,projectId:selection.projectId};
 // Candidate identity is the immutable package, not a particular test service
 // or Workspace. Different scenario installations must share this identity.
 const candidateDigest='sha256:'+selection.expectedManifestDigest;
 const collectorPins=Object.fromEntries(['support.mjs',scenario.toLowerCase()+'.test.mjs'].map(name=>[name,sha(fs.readFileSync(new URL(name,import.meta.url)))]));
 write('selection.json',{scenario,qualification:selection.qualification,candidate,candidateDigest,collectorPins,matrixDigest:sha(matrixBytes),selectedCaseIds:selectedIds,scenarioDenominator:all.length,fullDenominator:matrix.count,sourceQualification:'SEPARATE_E20_OBLIGATION'});
 let sequence=0,currentCase=null,uncertain=false;
 const evidence=[],results=[];
 async function request(operation,input={},meta={}){
  assert(!uncertain,'Inspect the original uncertain request before making another mutation');
  const envelope={operation,projectId:selection.projectId,input,...meta},id=String(++sequence).padStart(5,'0'),ref=id+'-request.json';
  write(ref,{caseInstanceId:currentCase,envelope});
  let response,raw;
  try{response=await fetch(connection.origin+'/api/v1/request',{method:'POST',headers:{...hostHeaders(connection),'content-type':'application/json'},body:JSON.stringify(envelope),signal:AbortSignal.timeout(30000),redirect:'error'});raw=await bounded(response);}
  catch(error){uncertain=!!meta.requestId;write(id+'-transport-failure.json',{caseInstanceId:currentCase,operation,requestId:meta.requestId??null,outcome:uncertain?'UNKNOWN':'READ_FAILED',automaticRetry:false});throw error;}
  const body=JSON.parse(raw),responseRef=id+'-response.json';write(responseRef,{caseInstanceId:currentCase,status:response.status,rawBody:raw,body});evidence.push({caseInstanceId:currentCase,request:ref,response:responseRef,responseDigest:sha(raw),fileDigest:sha(fs.readFileSync(path.join(selection.outputRoot,responseRef)))});
  return{status:response.status,body};
 }
 async function read(operation,input={}){const r=await request(operation,input);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.result;}
 async function source(revisionId){let offset=0;const chunks=[];for(;;){const page=await read('lifecycle.definition.source.read',{revisionId,offset});assert.equal(page.revisionId,revisionId);chunks.push(Buffer.from(page.data,'base64'));if(page.nextOffset===null)return Buffer.concat(chunks).toString('utf8');assert(page.nextOffset>offset);offset=page.nextOffset;}}
 const status=await read('runtime.status');assert.equal(status.serviceId,connection.serviceId);assert.equal(status.workspaceId,selection.workspaceId);assert.equal(status.version,manifest.version);
 return{selection,candidate,candidateDigest,cases,all,request,read,source,
  requestId:(caseId,suffix)=>scenario.toLowerCase()+'-'+sha(selection.runId+'|'+caseId+'|'+suffix).slice(0,48),
  async collect(c,fn){currentCase=c.caseInstanceId;const first=evidence.length;
   try{const assertions=await fn();results.push({caseInstanceId:c.caseInstanceId,status:'PASS',candidateDigest,qualification:selection.qualification,assertions,evidence:evidence.slice(first)});}
   catch(error){results.push({caseInstanceId:c.caseInstanceId,status:'FAILED',candidateDigest,qualification:selection.qualification,error:{name:error.name,message:error.message,code:error.code??null},evidence:evidence.slice(first)});throw error;}
   finally{write(c.caseInstanceId+'.json',results.at(-1));currentCase=null;}
  },
  finish(){
   // Revalidate selected installed bytes after the run. This never certifies CI,
   // actual Codex/browser journeys or another unexecuted acceptance instance.
   const after=inspectInstalledServiceSelection(selection.installedRoot);assert.equal(after.selectionDigest,current.selectionDigest);
   for(const [name,pin] of Object.entries(collectorPins))assert.equal(sha(fs.readFileSync(new URL(name,import.meta.url))),pin,'Collector changed during execution');
   const missing=all.filter(c=>!results.some(r=>r.caseInstanceId===c.caseInstanceId)).map(c=>c.caseInstanceId),passed=results.filter(r=>r.status==='PASS').length;
   const report={scenario,candidate,candidateDigest,qualification:selection.qualification,scenarioDenominator:all.length,fullDenominator:matrix.count,selected:cases.length,executed:results.length,passed,failed:results.length-passed,unexecutedCaseIds:missing,scenarioStatus:missing.length||passed!==all.length?'INCOMPLETE':'OBSERVED_PASS',productAcceptance:'NOT_EVALUATED',releaseAuthorized:false,dailyInstallationChanged:false,setupEvidence:evidence.filter(e=>e.caseInstanceId===null),results};
   write('REPORT.json',report);return report;
  }};
}
