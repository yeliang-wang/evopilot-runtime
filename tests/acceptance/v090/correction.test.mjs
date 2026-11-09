// LC original-execution collector. Tool observations never approve product or release.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const sha=b=>createHash('sha256').update(b).digest('hex'),self=fileURLToPath(import.meta.url);
export function assertCorrectionEntryLocation(sourceRoot,entry=self){
 const expected=path.join(sourceRoot,'tests/acceptance/v090/correction.test.mjs');
 assert.equal(entry,expected,'Use the exact committed correction entry; copied entries cannot select relative helpers');
 assert.equal(fs.realpathSync(entry),expected,'Correction entry must not redirect through a symlink');
}
const vectors=['cli-protocol-mismatch','command-fail','valid-output','unknown-cost'];
export const LC21_FAULTS=Object.freeze({'cli-protocol-mismatch':'// LC21 CONTROLLED ADAPTER OUTPUT FAULT; not an upstream tool result.\nprocess.stdout.write(JSON.stringify({lc21WrongProtocol:true}));\n','command-fail':'// LC21 CONTROLLED COMMAND FAILURE; not an upstream tool defect.\nprocess.stderr.write("LC21 controlled command failure\\n");process.exitCode=23;\n'});
const exact=(v,n)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...n].sort());};
function regular(ref,max=16777216,privateFile=false){assert(path.isAbsolute(ref)&&fs.realpathSync(ref)===ref);const before=fs.lstatSync(ref);assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=max);if(privateFile)assert(before.uid===process.getuid()&&(before.mode&0o077)===0);const same=s=>{for(const key of ['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'])assert.equal(s[key],before[key],'Original input changed while reading');},fd=fs.openSync(ref,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),bytes=Buffer.alloc(before.size+1);let n=0;try{same(fs.fstatSync(fd));while(n<bytes.length){const count=fs.readSync(fd,bytes,n,bytes.length-n,null);if(!count)break;n+=count;}assert.equal(n,before.size);same(fs.fstatSync(fd));same(fs.lstatSync(ref));return bytes.subarray(0,n);}finally{fs.closeSync(fd);}}
// Executables have their own installed-service bound; evidence inputs stay 16 MiB.
export function hashExecutable(ref){
 assert(path.isAbsolute(ref)&&fs.realpathSync(ref)===ref);const before=fs.lstatSync(ref);assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size>0&&before.size<=268435456);
 const same=stat=>{for(const key of ['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'])assert.equal(stat[key],before[key],'Executable identity changed while hashing');},fd=fs.openSync(ref,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),digest=createHash('sha256');let bytes=0;
 try{same(fs.fstatSync(fd));const buffer=Buffer.alloc(65536);for(;;){const count=fs.readSync(fd,buffer,0,buffer.length,null);if(!count)break;bytes+=count;assert(bytes<=before.size);digest.update(buffer.subarray(0,count));}assert.equal(bytes,before.size);same(fs.fstatSync(fd));same(fs.lstatSync(ref));return{path:ref,sha256:digest.digest('hex'),bytes,mode:before.mode&0o777};}finally{fs.closeSync(fd);}
}
function pinned(pin,max=16777216){exact(pin,['ref','sha256']);assert(/^[a-f0-9]{64}$/.test(pin.sha256));const b=regular(pin.ref,max,true);assert.equal(sha(b),pin.sha256);return b;}
export function correctionCatalog(addendum,phase){
 assert(['PRE_RELEASE','POST_RELEASE'].includes(phase));const cases=addendum.acceptance.cases;assert.equal(cases.length,21);assert.equal(new Set(cases.map(c=>c.id)).size,21);assert.deepEqual(cases.map(c=>c.id).sort(),Array.from({length:21},(_,i)=>'LC'+String(i+1).padStart(2,'0')));
 assert.deepEqual(cases.find(c=>c.id==='LC21').vectors,vectors);assert.deepEqual(cases.find(c=>c.id==='LC01').vectors,['source','candidate','toolchain','fixture','collector','platform','permission']);assert.equal(cases.filter(c=>c.phase==='PRE_RELEASE').length,20);assert.equal(cases.filter(c=>c.phase==='POST_RELEASE').length,1);assert.equal(cases.find(c=>c.id==='LC12').phase,'POST_RELEASE');return cases.filter(c=>c.phase===phase);
}
export function validateCorrectionCases(catalog,ids){assert(Array.isArray(ids)&&ids.length>0&&new Set(ids).size===ids.length);assert(ids.every(id=>catalog.some(c=>c.id===id)));return ids;}
export function parseLC21Driver(raw,vector){
 assert(vectors.includes(vector));assert.equal(raw.signal,null);assert.equal(raw.exceeded,null);assert(Number.isFinite(raw.elapsedMs)&&raw.elapsedMs>=0);assert(/^\{[^\r\n]*\}\n$/.test(raw.stdout),'Exactly one original driver JSON line required');const r=JSON.parse(raw.stdout);
 assert.equal(r.schema,'runtime-correction-tooling-result/v1');assert.equal(r.tool,'graph');assert.equal(r.toolIdentity.node,'v24.14.0');assert.equal(r.toolIdentity['dependency-cruiser'],'18.7.2');assert(Number.isFinite(r.elapsedMs)&&r.elapsedMs>=0);assert.equal(r.costStatus,'UNKNOWN');assert.equal(r.tokenUsage,null);assert.equal(r.monetaryCost,null);assert.equal(r.acceptance,'NOT_EVALUATED');
 if(vector==='cli-protocol-mismatch'){assert.equal(raw.code,1);assert.equal(r.status,'FAILED');assert.equal(r.error,'Invalid dependency graph protocol');}
 else if(vector==='command-fail'){assert.equal(raw.code,1);assert.equal(r.status,'FAILED');assert.match(r.error,/^graph exited 23: LC21 controlled command failure/);}
 else{assert.equal(raw.code,0);assert.equal(r.status,'COMPLETED');assert.equal(r.graph.closureComplete,false);assert(r.graph.modules>0&&r.graph.modules<=64&&r.graph.edges<=256);}
 return r;
}
function snapshotTree(root){const pins={};let size=0;function walk(dir){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),s=fs.lstatSync(file);assert(!s.isSymbolicLink(),'Tool package symlinks need separate reviewed closure');if(s.isDirectory())walk(file);else{assert(s.isFile()&&s.size<=33554432);size+=s.size;assert(size<=134217728);pins[path.relative(root,file)]={sha256:sha(fs.readFileSync(file)),bytes:s.size,mode:s.mode&0o777};}}}walk(root);return pins;}
export function toolClosure(sourceRoot,lock){const packages=new Map(),base=path.join(sourceRoot,'node_modules');function visit(root){root=fs.realpathSync(root);assert(root.startsWith(base+path.sep));if(packages.has(root))return;const pkg=JSON.parse(regular(path.join(root,'package.json'))),relative=path.relative(sourceRoot,root);assert.equal(lock.packages[relative]?.version,pkg.version,'Tool dependency differs from exact lock');packages.set(root,{name:pkg.name,version:pkg.version,relative,pins:snapshotTree(root)});for(const name of Object.keys({...pkg.dependencies,...pkg.optionalDependencies,...pkg.peerDependencies})){let current=root,found;while(current.startsWith(sourceRoot)){const target=path.join(current,'node_modules',name);if(fs.existsSync(path.join(target,'package.json'))){found=target;break;}if(current===sourceRoot)break;current=path.dirname(current);}if(!found){assert(!Object.hasOwn(pkg.dependencies??{},name),'Missing installed locked dependency '+name);continue;}visit(found);}}visit(path.join(base,'dependency-cruiser'));assert.equal(packages.get(fs.realpathSync(path.join(base,'dependency-cruiser'))).name,'dependency-cruiser');assert.equal(packages.get(fs.realpathSync(path.join(base,'dependency-cruiser'))).version,'18.7.2');visit(path.join(base,'typescript'));assert.equal(packages.get(fs.realpathSync(path.join(base,'typescript'))).name,'typescript');assert.equal(packages.get(fs.realpathSync(path.join(base,'typescript'))).version,'5.9.3','Dependency-cruiser dynamic TypeScript adapter must use the exact locked compiler');return packages;}
async function execute(command,args,cwd,env,timeout){return new Promise((resolve,reject)=>{const started=performance.now(),p=spawn(command,args,{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',bytes=0,exceeded=null;const stop=reason=>{if(exceeded)return;exceeded=reason;try{process.kill(-p.pid,'SIGKILL');}catch{}};const timer=setTimeout(()=>stop('TIME_LIMIT'),timeout);for(const [stream,key]of [[p.stdout,'stdout'],[p.stderr,'stderr']])stream.on('data',b=>{bytes+=b.length;if(bytes>2097152){stop('OUTPUT_LIMIT');return;}if(key==='stdout')stdout+=b.toString();else stderr+=b.toString();});p.once('error',e=>{clearTimeout(timer);reject(e);});p.once('close',(code,signal)=>{clearTimeout(timer);resolve({command,args,cwd,code,signal,stdout,stderr,exceeded,elapsedMs:performance.now()-started});});});}
export function correctionCounts(catalog,selected,results){const missing=catalog.filter(c=>!results.some(r=>r.caseInstanceId===c.id)).map(c=>c.id);return{scenarioDenominator:catalog.length,fullDenominator:709,selected:selected.length,executed:results.length,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status!=='PASS').length,unexecutedCaseIds:missing,scenarioStatus:missing.length||results.some(r=>r.status!=='PASS')?'INCOMPLETE':'OBSERVED_PASS'};}
export const LC20_VECTORS=Object.freeze(['unrelated','direct','transitive','missing-edge-fallback']),LC20_CHILDREN=Object.freeze(['a','b','c','d','e','f']);
const lc20Graph={a:[],b:['a'],c:['b'],d:[],e:['d'],f:[]};
const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
const lc20Digest=v=>'sha256:'+sha(stable(v));
/** Resumable original API controller. It NEVER writes a decision or grant.
 * WAITING_FOR_GRANT contains the exact prepared review for the independent
 * existing grant workflow; UNKNOWN only reads the original request receipt. */
// Read only: a retained child may lie beyond the first history page. Every
// page belongs to one fixed watermark; uncertainty never re-executes the child.
export async function findLc20OriginalAttempt(read,registrationRef,requestId){
 let afterRequestId,watermark,total;const seen=new Set();
 for(let page=0;page<83;page++){
  const history=await read('lifecycle.qualification.origin.inspect',{registrationRef,caseId:'LC20',limit:50,...(afterRequestId?{afterRequestId}:{})});
  assert.equal(history.producer,'CLOSED_PROBE');assert.equal(history.formalAcceptanceEligible,false);
  assert(Number.isSafeInteger(history.totalAttempts)&&history.totalAttempts>=0&&history.totalAttempts<=4096);
  assert(/^sha256:[a-f0-9]{64}$/.test(history.historyWatermark));
  if(page===0){watermark=history.historyWatermark;total=history.totalAttempts;}
  else{assert.equal(history.historyWatermark,watermark,'Original child history changed while paging');assert.equal(history.totalAttempts,total);}
  assert(Array.isArray(history.attempts)&&history.attempts.length<=50);
  for(const attempt of history.attempts){assert(typeof attempt.requestId==='string'&&attempt.requestId.length>0&&!seen.has(attempt.requestId),'Duplicate original child history');seen.add(attempt.requestId);}
  assert(seen.size<=total);
  const next=history.nextRequestId;
  if(next===null)assert.equal(seen.size,total,'Truncated original child history');
  else{assert(history.attempts.length>0&&next===history.attempts.at(-1).requestId&&next!==afterRequestId&&seen.size<total,'Invalid original child history cursor');}
  const found=history.attempts.find(attempt=>attempt.requestId===requestId);
  if(found){assert(found.original,'Original child execution is unresolved; inspect its original request');return found;}
  if(next===null)break;afterRequestId=next;
 }
 assert.fail('Original child execution is not observable; do not redispatch');
}

export async function collectLc20Controller(config){
 exact(config,['schema','installedRoot','connectionRef','fixtureRoot','registrations','candidateDigest','sourceCommit','requestId','inputDigest','contractDigest','deadlineAt','outputRoot','producerJobId','sourceRoot','inputFiles','mode']);assert.equal(config.schema,'runtime-lc20-controller/v1');assert(['EXECUTE','INVENTORY'].includes(config.mode));exact(config.registrations,LC20_CHILDREN);assert(LC20_CHILDREN.every(id=>/^binding:/.test(config.registrations[id])));for(const key of ['candidateDigest','inputDigest','contractDigest'])assert(/^sha256:[a-f0-9]{64}$/.test(config[key]));assert(/^[a-f0-9]{40}$/.test(config.sourceCommit));assert(/^[1-9][0-9]{0,19}$/.test(config.producerJobId));assert(config.inputFiles&&typeof config.inputFiles==='object');
 const deadline=Date.parse(config.deadlineAt);assert(Number.isFinite(deadline)&&deadline>Date.now(),'Original controller deadline expired');const root=fs.realpathSync(config.outputRoot);assert.equal(root,config.outputRoot);assert.equal(fs.statSync(root).mode&0o077,0);assert.equal(config.fixtureRoot,path.join(root,'fixture'));assert.equal(fs.realpathSync(config.fixtureRoot),config.fixtureRoot);
 const installed=fs.realpathSync(config.installedRoot),manifest=regular(path.join(installed,'distribution-manifest.json'));assert.equal('sha256:'+sha(manifest),config.candidateDigest);const clientModule=await import(pathToFileURL(path.join(installed,'package/dist/host/client.js')).href),client=clientModule.createRuntimeHttpClient(config.connectionRef),identity=(await client.status()).result;assert.equal(identity.product,'evopilot-runtime');
 const inputPath=path.join(root,'evidence/lc20-input-snapshot.json');
 const statePath=path.join(root,'controller-state.json'),state=fs.existsSync(statePath)?JSON.parse(regular(statePath,1048576,true)):{schema:'runtime-lc20-controller-state/v1',configDigest:lc20Digest(config),startedAt:new Date().toISOString(),vector:0,phase:'BASELINE',vectors:[],working:null,inputSnapshotDigest:null,protocolBefore:null};assert.equal(state.schema,'runtime-lc20-controller-state/v1');assert.equal(state.configDigest,lc20Digest(config));
 const save=()=>{const temporary=statePath+'.pending';fs.writeFileSync(temporary,JSON.stringify(state)+'\n',{mode:0o600});fs.renameSync(temporary,statePath);},signal=()=>AbortSignal.timeout(Math.max(1,Math.min(30000,deadline-Date.now()))),folder=path.join(root,'observations');fs.mkdirSync(folder,{recursive:true,mode:0o700});
 const pin=file=>({path:path.relative(root,file).split(path.sep).join('/'),digest:'sha256:'+sha(regular(file,2097152,true)),bytes:fs.statSync(file).size});
 const retain=(key,value)=>{assert(/^[A-Za-z0-9._-]+$/.test(key));const file=path.join(folder,key+'.json'),bytes=JSON.stringify(value)+'\n';if(fs.existsSync(file))assert.equal(regular(file,2097152,true).toString(),bytes,'Original controller evidence changed');else fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'});return pin(file);};
 const read=async(operation,input)=>{assert(Date.now()<deadline);return(await client.request({operation,projectId:client.connection.projectId,input},signal())).result;};
 const mutation=async(key,operation,input)=>{const file=path.join(folder,key+'.request.json'),response=path.join(folder,key+'.response.json');if(fs.existsSync(response))return JSON.parse(regular(response,131072,true));let envelope;
  if(fs.existsSync(file)){envelope=JSON.parse(regular(file,131072,true));assert.equal(envelope.operation,operation);assert.equal(stable(envelope.input),stable(input));const result=await read('runtime.receipt.read',{requestId:envelope.requestId});retain(key+'.response',result);return result;}
  const status=await read('runtime.status',{});envelope={operation,projectId:client.connection.projectId,input,requestId:'lc20-'+sha(config.requestId+':'+key).slice(0,48),expectedRevision:status.revision};retain(key+'.request',envelope);const result=(await client.request(envelope,signal())).result;retain(key+'.response',result);return result;};
 const writeFixture=(vector,changed)=>{const a=changed&&vector==='transitive'?4:3,d=7,f=changed&&vector==='direct'?12:11,values={a,b:a+1,c:a+2,d,e:d+1,f},files={'a.json':{value:a},'d.json':{value:d},'f.json':{value:f},'graph.json':changed&&vector==='missing-edge-fallback'?{...lc20Graph,c:[]}:lc20Graph};for(const id of LC20_CHILDREN)files['expected-'+id+'.json']={canonicalDigest:lc20Digest({value:values[id]})};for(const [name,value]of Object.entries(files))fs.writeFileSync(path.join(config.fixtureRoot,name),stable(value),{mode:0o600});fs.writeFileSync(path.join(config.fixtureRoot,'unrelated.txt'),changed&&vector==='unrelated'?'changed unrelated bytes':'baseline unrelated bytes',{mode:0o600});};
 const child=async(key,id,candidate)=>{const registrationRef=config.registrations[id],receipt=await mutation(key,'lifecycle.qualification.probe.execute',{registrationRef,caseId:'LC20',candidateDigest:candidate,expiresAt:config.deadlineAt}),attempt=await findLc20OriginalAttempt(read,registrationRef,receipt.requestId);const originalExecutionDigest=lc20Digest(attempt.original),observed=await read('lifecycle.qualification.origin.inspect',{registrationRef,caseId:'LC20',originalExecutionDigest,currentCandidateDigest:candidate});assert.equal(observed.formalAcceptanceEligible,false);assert.equal(observed.original.mode,'EXECUTED');assert.equal(observed.original.outcome,'PASS');const proof={schema:'runtime-lc20-child-observation/v1',id,originalExecutionDigest,original:observed.original,rawReceipt:observed.rawReceipt};return{id,receipt:retain(key+'.original',proof),proof};};
 save();try{
 const protocol=await read('lifecycle.qualification.origin.inspect',{registrationRef:config.registrations.a,caseId:'LC20',originRef:'stage-request:'+config.requestId,protocol:'runtime-lc20-local-installed/v1'});assert.equal(protocol.stageRequestId,config.requestId);assert.equal(protocol.inputDigest,config.inputDigest);assert.equal(protocol.contractDigest,config.contractDigest);assert.equal(protocol.mode,config.mode);const proven=protocol.disposition==='PROVEN_FIXED_INPUTS'&&protocol.current.installedCandidateDigest===config.candidateDigest;
 if(state.inputSnapshotDigest===null){
  assert.equal(state.vector,0);assert.equal(state.working,null);assert.equal(state.vectors.length,0);assert(!fs.existsSync(inputPath),'Input snapshot must be captured by this exact controller before first execution');const contract=protocol.contract,inputs=[],unavailableInputs=[];fs.mkdirSync(path.dirname(inputPath),{recursive:true,mode:0o700});fs.mkdirSync(path.join(root,'inputs'),{recursive:true,mode:0o700});
  for(const node of contract.nodes){const runtime=protocol.original.inputs.find(i=>i.id===node.id);let bytes;if(node.id.startsWith('runtime:')){if(!runtime||node.digest!==null){unavailableInputs.push(node.id);continue;}bytes=Buffer.from(runtime.raw);}else{const selected=config.inputFiles[node.id];assert(typeof selected==='string'&&path.isAbsolute(selected));bytes=regular(selected,268435456);if(node.sourcePath!==null){assert.equal(selected,path.join(config.sourceRoot,node.sourcePath));const original=execFileSync('git',['-C',config.sourceRoot,'show',config.sourceCommit+':'+node.sourcePath],{maxBuffer:268435456});assert.equal(sha(bytes),sha(original));}if(node.candidatePath!==null){const actual=regular(path.join(installed,'package',node.candidatePath),268435456);assert.equal(sha(bytes),sha(actual));}}assert.equal('sha256:'+sha(bytes),runtime?.digest??node.digest);const file=path.join(root,'inputs',sha(node.id)+'.bin');fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'});inputs.push({id:node.id,file:{path:path.relative(root,file).split(path.sep).join('/'),digest:'sha256:'+sha(bytes),bytes:bytes.length}});}
  const snapshot={schema:'runtime-lc20-input-snapshot/v1',contractDigest:config.contractDigest,mode:config.mode,requestId:config.requestId,inputDigest:config.inputDigest,sourceCommit:config.sourceCommit,candidateDigest:config.candidateDigest,producerJobId:config.producerJobId,inputs,...(unavailableInputs.length?{unavailableInputs}:{})};fs.writeFileSync(inputPath,JSON.stringify(snapshot)+'\n',{mode:0o600,flag:'wx'});state.inputSnapshotDigest='sha256:'+sha(regular(inputPath,131072,true));state.protocolBefore=retain('protocol-before',protocol);save();
 }else{assert.equal('sha256:'+sha(regular(inputPath,131072,true)),state.inputSnapshotDigest,'Execution input snapshot changed');const before=JSON.parse(regular(path.join(root,state.protocolBefore.path),2097152,true));assert.equal(before.stageRequestDigest,protocol.stageRequestDigest);assert.deepEqual(before.original,protocol.original);}
 if(config.mode==='INVENTORY'){
  const after=await read('lifecycle.qualification.origin.inspect',{registrationRef:config.registrations.a,caseId:'LC20',originRef:'stage-request:'+config.requestId,protocol:'runtime-lc20-local-installed/v1'}),complete=proven&&after.disposition==='PROVEN_FIXED_INPUTS'&&stable(after.current.inputs)===stable(protocol.original.inputs);const receipt={schema:'runtime-lc20-inventory-capture/v1',mode:'INVENTORY',requestId:config.requestId,inputDigest:config.inputDigest,candidateDigest:config.candidateDigest,inputSnapshotDigest:state.inputSnapshotDigest,protocol:{before:state.protocolBefore,after:retain('protocol-after',after)},status:complete?'INPUTS_OBSERVED':'UNKNOWN',executed:false,formalCaseCredit:0};return{status:complete?'INPUT_SNAPSHOT_COMPLETE':'FULL_EXECUTION_REQUIRED',caseId:'LC20',receipt:retain('inventory',receipt),executed:false,formalSubcaseCredit:0};
 }
 for(;state.vector<LC20_VECTORS.length;){
  const vector=LC20_VECTORS[state.vector],before=lc20Digest({candidate:config.candidateDigest,vector,fixture:'baseline'}),after=lc20Digest({candidate:config.candidateDigest,vector,fixture:'current'});
  state.working??={id:vector,baseline:[],selective:[],full:[],decisions:[],outcome:'UNKNOWN'};const w=state.working;
  if(state.phase==='BASELINE'){writeFixture(vector,false);for(const id of LC20_CHILDREN)if(!w.baseline.some(x=>x.id===id)){w.baseline.push(await child(vector+'-baseline-'+id,id,before));save();}state.phase='MODIFIED';save();}
  writeFixture(vector,true);
  for(const id of LC20_CHILDREN)if(!w.decisions.some(x=>x.id===id)){
   const registrationRef=config.registrations[id],original=w.baseline.find(x=>x.id===id).proof,preview=await read('lifecycle.qualification.origin.inspect',{registrationRef,caseId:'LC20',originalExecutionDigest:original.originalExecutionDigest,currentCandidateDigest:after});let decision=preview;
   if(preview.disposition==='ASSESSMENT_REQUIRED'){
    const planned=await mutation(vector+'-plan-'+id,'lifecycle.qualification.plan',{registrationRef,caseId:'LC20',currentCandidateDigest:after,originalExecutionDigest:original.originalExecutionDigest,phase:'PRE_RELEASE',deadlineAt:config.deadlineAt}),planRef=planned.result.planRef;
    try{await read('lifecycle.qualification.assessment.inspect',{planRef});}catch(error){if(error.code!=='QUALIFICATION_AUTHORITY_REQUIRED')throw error;const review=await read('lifecycle.qualification.assessment.preview',{planRef});save();return{status:'WAITING_FOR_GRANT',caseId:'LC20',vector,id,planRef,review,completedVectors:state.vectors.length,executionAuthorized:false};}
    const prepared=await mutation(vector+'-prepare-'+id,'lifecycle.qualification.prepare',{planRef}),actionRef=prepared.result.actionRef;await mutation(vector+'-dispatch-'+id,'lifecycle.qualification.dispatch',{actionRef});decision=await read('lifecycle.qualification.inspect',{actionRef});if(decision.status!=='QUALIFIED'){save();return{status:'OBSERVE_ORIGINAL',caseId:'LC20',vector,id,actionRef,qualification:decision,completedVectors:state.vectors.length,automaticRedispatch:false};}assert.equal(decision.mode,'PASS_REUSED');assert.equal(decision.formalAcceptanceEligible,false);
   }else{assert.equal(preview.disposition,'EXECUTION_REQUIRED');w.selective.push(await child(vector+'-selective-'+id,id,after));}
   w.decisions.push({id,qualification:retain(vector+'-decision-'+id,decision)});save();
  }
  for(const id of LC20_CHILDREN)if(!w.full.some(x=>x.id===id)){w.full.push(await child(vector+'-full-'+id,id,after));save();}
  const expected=vector==='unrelated'?[]:vector==='direct'?['f']:vector==='transitive'?['a','b','c']:[...LC20_CHILDREN];assert.deepEqual(w.selective.map(x=>x.id).sort(),expected);for(const id of LC20_CHILDREN){const selected=w.selective.find(x=>x.id===id)??w.baseline.find(x=>x.id===id),full=w.full.find(x=>x.id===id);assert.deepEqual(JSON.parse(selected.proof.rawReceipt).result,JSON.parse(full.proof.rawReceipt).result);assert.notEqual(selected.proof.original.runId,full.proof.original.runId);}
  const vectorRecord={...w,baseline:w.baseline.map(({id,receipt})=>({id,receipt})),selective:w.selective.map(({id,receipt})=>({id,receipt})),full:w.full.map(({id,receipt})=>({id,receipt})),outcome:'PASS'};state.vectors.push(vectorRecord);state.working=null;state.phase='BASELINE';state.vector++;save();
 }
 const after=await read('lifecycle.qualification.origin.inspect',{registrationRef:config.registrations.a,caseId:'LC20',originRef:'stage-request:'+config.requestId,protocol:'runtime-lc20-local-installed/v1'});assert.equal(after.stageRequestDigest,protocol.stageRequestDigest);const reuseInputsProven=proven&&after.disposition==='PROVEN_FIXED_INPUTS'&&stable(after.current.inputs)===stable(protocol.original.inputs);assert.equal('sha256:'+sha(regular(inputPath,131072,true)),state.inputSnapshotDigest);const protocolAfter=retain('protocol-after',after);const result={schema:'runtime-lc20-complete-execution/v1',caseId:'LC20',phase:'PRE_RELEASE',mode:'EXECUTED',contractDigest:config.contractDigest,requestId:config.requestId,inputDigest:config.inputDigest,sourceCommit:config.sourceCommit,candidateDigest:config.candidateDigest,startedAt:state.startedAt,completedAt:new Date().toISOString(),inputSnapshotDigest:state.inputSnapshotDigest,protocol:{before:state.protocolBefore,after:protocolAfter},vectors:state.vectors,outcome:'PASS'};const final=path.join(root,'evidence/lc20-execution.json');if(!fs.existsSync(final))fs.writeFileSync(final,JSON.stringify(result)+'\n',{mode:0o600,flag:'wx'});return{status:'COMPLETE',caseId:'LC20',receipt:pin(final),rawReceipt:JSON.parse(regular(final,131072,true)),reuseInputsProven,formalSubcaseCredit:0};
 }catch(error){save();return{status:error.code==='REQUEST_OUTCOME_UNKNOWN'||error.code==='NOT_FOUND'?'OBSERVE_ORIGINAL':'INCOMPLETE',caseId:'LC20',vector:LC20_VECTORS[state.vector]??null,error:{code:error.code??'COLLECTOR_FAILURE',message:error.message},completedVectors:state.vectors.length,automaticRedispatch:false};}
}
// LC01's fixture is an immutable reviewed descriptor, separate from the selection
// containing expectedBindings: no fixture can include its own expected hash.
export const LC01_VECTORS=Object.freeze(['source','candidate','toolchain','fixture','collector','platform','permission']);
export function verifyLc01InstalledBytes(installedRoot,expectedManifestDigest){
 const bytes=regular(path.join(installedRoot,'distribution-manifest.json'));
 assert.equal(sha(bytes),expectedManifestDigest,'LC01 unverified installed manifest');
 const manifest=JSON.parse(bytes);assert.equal(manifest.schema,'runtime-standalone-distribution/v1');
 assert(manifest.files&&Object.keys(manifest.files).length>0&&Object.keys(manifest.files).length<=10000);
 for(const name of ['dist/lifecycle/correction-planner.js','dist/host/client.js','dist/server/security.js','dist/installation/service-control.js'])assert(manifest.files[name],'LC01 missing installed public module');
 // Verify the entire module closure before the first installed import, including
 // transitive dependencies. A source loader cannot substitute checkout modules.
 for(const [name,pin]of Object.entries(manifest.files)){
  assert(!path.isAbsolute(name)&&!name.split('/').some(p=>!p||p==='.'||p==='..'));
  if(pin.type==='symlink'){const ref=path.join(installedRoot,'package',name);assert(fs.lstatSync(ref).isSymbolicLink());assert.equal(fs.readlinkSync(ref),pin.target);const target=path.resolve(path.dirname(ref),pin.target);assert(target.startsWith(path.join(installedRoot,'package')+path.sep));assert.equal(manifest.files[path.relative(path.join(installedRoot,'package'),target)]?.type,'file');assert.equal(fs.realpathSync(ref),target);continue;}
  assert.equal(pin.type,'file');const actual=regular(path.join(installedRoot,'package',name));
  assert.equal(actual.length,pin.bytes);assert.equal(sha(actual),pin.sha256,'LC01 wrong installed module bytes: '+name);
 }
 return manifest;
}
export async function runLc01Vectors(preflight,expected,observe,callback,onRow=()=>{}){
 assert.equal(typeof preflight,'function');assert.equal(typeof observe,'function');assert.equal(typeof callback,'function');exact(expected,LC01_VECTORS);
 for(const value of Object.values(expected))assert(/^sha256:[a-f0-9]{64}$/.test(value));
 const cases=[{id:'LC01',phase:'PRE_RELEASE',dependsOn:[],entry:'LC01.readonly-control'}],rows=[];
 let callbacks=0;const guarded=async()=>{callbacks++;return callback();},registry=new Map([['LC01.readonly-control',guarded]]);
 for(const vector of LC01_VECTORS){
  const observation=await observe(),faultExpected=structuredClone(expected);
  faultExpected[vector]='sha256:'+sha('LC01 labelled EXPECTED mismatch: '+vector+':'+expected[vector]);
  const input={phase:'PRE_RELEASE',expected:faultExpected,observed:observation.bindings,cases};
  const before=callbacks,raw=preflight(input,registry);
  // This is the same dispatch guard for positive and negative input; a product
  // regression that incorrectly admits a mismatch invokes only a status read.
  if(raw.ready)await guarded();
  const row={vectorId:vector,fault:{kind:'EXPECTED_BINDING_ONLY',category:vector,original:expected[vector],replacement:faultExpected[vector]},input,observation,raw,callbackCount:callbacks-before};rows.push(row);
  row.status=!raw.ready&&raw.dispatchAuthorized===false&&stable(raw.issues)===stable([{code:'BINDING_MISMATCH',id:vector}])&&row.callbackCount===0?'PASS':'FAILED';onRow(row);
 }
 const observation=await observe(),input={phase:'PRE_RELEASE',expected:structuredClone(expected),observed:observation.bindings,cases},raw=preflight(input,registry),before=callbacks;
 const response=raw.ready?await guarded():null;
 const positive={input,observation,raw,response,callbackCount:callbacks-before};
 return{vectors:rows,positive,status:rows.every(r=>r.status==='PASS')&&raw.ready&&raw.dispatchAuthorized===false&&raw.issues.length===0&&positive.callbackCount===1?'PASS':'FAILED',fullCatalogCallable:'NOT_READY',productAcceptance:'NOT_EVALUATED'};
}
async function collectLc01(selection,catalog,installed,plan){
 assert.deepEqual(selection.caseIds,['LC01']);assert.equal(selection.phase,'PRE_RELEASE');assert(selection.lc01,'LC01 requires real protected fixture configuration');
 assert(!process.execArgv.some(a=>/loader|--import|--require|^-r$/.test(a))&&!process.env.NODE_OPTIONS,'LC01 installed execution forbids module substitution');
 const config=JSON.parse(pinned(selection.lc01));exact(config,['schema','descriptor','expectedBindings']);assert.equal(config.schema,'runtime-lc01-binding-selection/v1');exact(config.expectedBindings,LC01_VECTORS);
 const descriptorBytes=pinned(config.descriptor),descriptor=JSON.parse(descriptorBytes);
 exact(descriptor,['schema','sourceRoot','sourceCommit','installedRoot','candidateDigest','nodeSha256','principal','service']);assert.equal(descriptor.schema,'runtime-lc01-reviewed-input/v1');
 for(const key of ['sourceRoot','sourceCommit','installedRoot'])assert.equal(descriptor[key],selection[key]);assert.equal(descriptor.candidateDigest,'sha256:'+selection.expectedManifestDigest);assert.equal(descriptor.nodeSha256,plan.nodeSha256);
 const root=selection.installedRoot,module=name=>pathToFileURL(path.join(root,'package',name)).href;
 verifyLc01InstalledBytes(root,selection.expectedManifestDigest);
 const {preflightCorrection}=await import(module('dist/lifecycle/correction-planner.js')),{createRuntimeHttpClient}=await import(module('dist/host/client.js')),{authenticate,authorize,hostHeaders}=await import(module('dist/server/security.js'));
 const {observeAcceptanceBindings}=await import('./preflight.mjs');
 const client=createRuntimeHttpClient(path.join(root,'connection.json'));
 const profiles={source:[selection.sourceRevision.ref,path.join(selection.sourceRoot,'src/lifecycle/correction-planner.ts'),path.join(selection.sourceRoot,'governance/lifecycle-correction-v090.json')],candidate:[path.join(root,'distribution-manifest.json'),path.join(root,'package/dist/lifecycle/correction-planner.js')],toolchain:[path.join(root,'installation-plan.json'),path.join(selection.sourceRoot,'package-lock.json')],fixture:[config.descriptor.ref],collector:[self,path.join(selection.sourceRoot,'tests/acceptance/v090/preflight.mjs')],permission:[path.join(root,'connection.json'),path.join(root,'client.json'),path.join(root,'data/auth.json')]};
 const observe=async()=>{
  assert.equal(execFileSync('git',['-C',selection.sourceRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),selection.sourceCommit);
  execFileSync('git',['-C',selection.sourceRoot,'diff','--quiet',selection.sourceCommit,'--'],{stdio:'pipe'});
  verifyLc01InstalledBytes(root,selection.expectedManifestDigest);
  assert.equal(sha(pinned(config.descriptor)),sha(descriptorBytes));
  const node=hashExecutable(fs.realpathSync(process.execPath));assert.equal(node.sha256,descriptor.nodeSha256);
  const bindings=observeAcceptanceBindings(profiles),principal=authenticate(path.join(root,'data'),plan.workspaceId,hostHeaders(client.connection).Authorization);
  authorize(principal,plan.projectId,'read');assert.equal(principal.id,client.connection.principalId);assert.deepEqual(principal,descriptor.principal);
  const live=await client.status(AbortSignal.timeout(10000)),status=live.result;
  const service=Object.fromEntries(['product','contract','serviceId','workspaceId','projectId','version','independentLlm'].map(k=>[k,status[k]]));assert.deepEqual(service,descriptor.service);assert.equal(service.serviceId,installed.serviceId);
  bindings.toolchain='sha256:'+sha(stable({files:bindings.toolchain,node}));bindings.permission='sha256:'+sha(stable({files:bindings.permission,principal,service}));
  return{bindings,principal,service,live,observedAt:new Date().toISOString(),node};
 };
 // Fail missing/stale preparation before creating an output directory. Never
 // repair expectations from current observations inside the execution collector.
 const initial=await observe();assert.deepEqual(initial.bindings,config.expectedBindings,'LC01 reviewed expected bindings differ from actual protected inputs');
 const output=selection.outputRoot;assert(path.isAbsolute(output)&&path.resolve(output)===output&&!fs.existsSync(output));assert.equal(fs.realpathSync(path.dirname(output)),path.dirname(output));assert(!output.startsWith(selection.sourceRoot+path.sep)&&!output.startsWith(root+path.sep));
 fs.mkdirSync(output,{mode:0o700});
 const save=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
 const manifest=JSON.parse(regular(path.join(root,'distribution-manifest.json')));
 const candidate={manifestDigest:selection.expectedManifestDigest,archiveDigest:manifest.archiveDigest,version:manifest.version,serviceId:installed.serviceId,workspaceId:plan.workspaceId,projectId:plan.projectId};
 const candidateDigest=descriptor.candidateDigest,setupEvidence=[];
 const artifact=(leaf,value,caseId=null,vectorId=null)=>{save(leaf,value);return{caseInstanceId:caseId,vectorId,artifact:leaf,fileDigest:sha(regular(path.join(output,leaf)))};};
 save('selection.json',{scenario:'LC',sourceCommit:selection.sourceCommit,phase:selection.phase,addendumDigest:sha(regular(path.join(selection.sourceRoot,'governance/lifecycle-correction-v090.json'))),qualification:selection.qualification,candidate,candidateDigest,collectorPins:{'correction.test.mjs':sha(regular(self))},selectedCaseIds:selection.caseIds});
 setupEvidence.push(artifact('LC01-bindings.json',{selection,config,descriptor,profiles,initial,installed,productAcceptance:'NOT_EVALUATED'}));
 const rows=[];
 let result;try{
  const execution=await runLc01Vectors(preflightCorrection,config.expectedBindings,observe,()=>client.status(AbortSignal.timeout(10000)),row=>{
   const evidence=artifact('LC01-'+row.vectorId+'.json',row,'LC01',row.vectorId);
   rows.push({vectorId:row.vectorId,phase:selection.phase,status:row.status,qualification:selection.qualification,candidateDigest,assertions:{expectedOnlyFault:row.fault.kind==='EXPECTED_BINDING_ONLY',callbackCount:row.callbackCount,observedBindingRetained:true},evidence:[evidence]});
  });
  setupEvidence.push(artifact('LC01-positive.json',execution.positive));
  const final=await observe();assert.deepEqual(final.bindings,initial.bindings);setupEvidence.push(artifact('LC01-integrity.json',final));
  result={caseInstanceId:'LC01',phase:selection.phase,status:execution.status,qualification:selection.qualification,candidateDigest,assertions:{allSevenVectorsExecuted:rows.length===7,positiveCallbackCount:execution.positive.callbackCount,integrityReadbackPassed:true,fullCatalogCallable:'NOT_READY'},vectors:rows};
 }catch(error){
  setupEvidence.push(artifact('LC01-failure.json',{message:error.message,code:error.code??'COLLECTOR_FAILURE',automaticRetry:false}));
  result={caseInstanceId:'LC01',phase:selection.phase,status:'FAILED',qualification:selection.qualification,candidateDigest,assertions:{integrityReadbackPassed:false,automaticRetry:false},vectors:rows};
 }
 save('LC01.json',result);save('REPORT.json',{schema:'runtime-correction-acceptance-report/v1',scenario:'LC',sourceCommit:selection.sourceCommit,phase:selection.phase,candidate,candidateDigest,selectionDigest:sha(regular(path.join(output,'selection.json'))),qualification:selection.qualification,...correctionCounts(catalog,selection.caseIds,[result]),results:[result],setupEvidence,productAcceptance:'NOT_EVALUATED',releaseAuthorized:false});
 assert.equal(result.status,'PASS','LC01 original binding observations failed');return output;
}
// These lanes observe existing native failures and existing governed repair
// history. Preparing those histories is a separate, exactly authorized workflow.
// No selector can ask this collector to seed state, issue authority or dispatch.
export const LC_NATIVE_VECTORS=Object.freeze({LC03:['same-text-different-baseline','facts-vs-hypothesis','unknown'],LC04:['preparation-defect','product-defect','unproven'],LC05:['transient-bounded','unchanged-deterministic','two-no-progress']});
export function validateLcNativeSelection(config,selection){
 exact(config,['schema','candidateDigest','sourceCommit','workspaceId','projectId','caseId','vectors']);
 assert.equal(config.schema,'runtime-lc-native-selection/v1');assert.equal(config.candidateDigest,'sha256:'+selection.expectedManifestDigest);assert.equal(config.sourceCommit,selection.sourceCommit);
 assert.deepEqual(selection.caseIds,[config.caseId]);assert(LC_NATIVE_VECTORS[config.caseId]);assert.equal(selection.phase,'PRE_RELEASE');
 for(const k of ['workspaceId','projectId'])assert(typeof config[k]==='string'&&config[k].length>0);
 exact(config.vectors,LC_NATIVE_VECTORS[config.caseId]);
 for(const [vector,v]of Object.entries(config.vectors)){
  const second=vector==='same-text-different-baseline',retry=vector==='transient-bounded';
  exact(v,['original',...(second?['second']:[]),...(vector==='unknown'?[]:['correctionRef']),...(retry?['retry']:[])]);
  for(const role of ['original',...(second?['second']:[]),...(retry?['retry']:[])]){const p=v[role];exact(p,['stageRequestId','record']);assert(typeof p.stageRequestId==='string'&&p.stageRequestId.length>0&&p.stageRequestId.length<=128);exact(p.record,['ref','sha256']);assert(path.isAbsolute(p.record.ref)&&/^[a-f0-9]{64}$/.test(p.record.sha256));}
  if(vector!=='unknown')assert(/^correction:sha256:[a-f0-9]{64}$/.test(v.correctionRef));
 }
 return config;
}
function nativeHash(value){return 'sha256:'+sha(stable(value));}
export function assertLcNativeOriginal(stage,retained,config,id,phases=['FAILED','UNKNOWN']){
 // Retained pins select original immutable bytes, never expected outcomes.
 exact(retained,['request','progress']);assert.deepEqual(stage.request,retained.request);assert.deepEqual(stage.progress,retained.progress);
 const r=stage.request,p=stage.progress,{digest,...body}=r;assert.equal(r.id,id);assert.equal(r.workspaceId,config.workspaceId);assert.equal(r.projectId,config.projectId);assert.equal(nativeHash(body),digest);assert.equal(p.requestId,id);assert.equal(stage.automaticRedispatch,false);
 assert(phases.includes(p.phase));assert.equal(p.terminal,p.phase!=='UNKNOWN');assert(p.observation&&p.observationRef);assert.equal(p.observation.requestId,id);assert.equal(p.observation.inputDigest,r.inputDigest);assert.equal(p.observation.outcome.status,p.phase==='COMPLETE'?'COMPLETE':p.phase==='FAILED'?'FAILED':'UNKNOWN');
 return stage;
}
function assertNativeFacts(view,stage){
 const f=view.facts,r=stage.request,p=stage.progress;assert.equal(view.executionAuthorized,false);assert.equal(view.releaseAuthorized,false);assert.equal(view.automaticRedispatch,false);
 for(const [k,v]of Object.entries({originalRequestId:r.id,originalRequestDigest:r.digest,instanceId:r.instanceId,stageId:r.stageId,pinsDigest:r.pinsDigest,inputDigest:r.inputDigest,planDigest:r.planDigest,adapterId:r.plan.adapterId,adapterDigest:r.plan.adapterDigest,bindingDigest:r.plan.bindingDigest,authorityRef:r.authorityRef,deadlineAt:r.deadlineAt,phase:p.phase,terminal:p.terminal,reason:p.reason,observationRef:p.observationRef,observationDigest:nativeHash(p.observation)}))assert.deepEqual(f[k],v);
 if(view.proposal){assert.equal(view.proposal.input.stageRequestId,r.id);assert.equal(view.proposal.factsDigest,nativeHash(view.proposal.facts));assert.deepEqual(view.proposal.facts,f);assert.equal(view.proposalCurrent,true);assert.equal(view.proposal.factsDigest,nativeHash(f));}
}
export async function observeLcNativeVector(caseId,vector,binding,read,loadOriginal){
 assert(LC_NATIVE_VECTORS[caseId]?.includes(vector));
 const stage=await loadOriginal(binding.original),id=stage.request.id;
 const input={stageRequestId:id,...(binding.correctionRef?{correctionRef:binding.correctionRef}:{})};
 const view=await read('lifecycle.correction.inspect',input);assertNativeFacts(view,stage);
 if(vector==='unknown'){
  assert.equal(stage.progress.phase,'UNKNOWN');assert.equal(view.proposal,null);
  return{expected:'Original UNKNOWN is inspected without mutation or redispatch',actual:{phase:view.facts.phase,originalRequestId:id},assertions:{originalUnknownRetained:true,inspectOnly:true}};
 }
 assert.equal(stage.progress.phase,'FAILED');assert(view.proposal,'NOT_READY: an existing native proposal is required');
 assert.equal(view.nativeEvidence.status,'AVAILABLE','NOT_READY: original native evidence unavailable');assert.equal(view.nativeEvidence.originalRequestId,id);assert.equal(view.nativeEvidence.originalRequestDigest,stage.request.digest);
 if(vector==='same-text-different-baseline'){
  const second=await loadOriginal(binding.second),other=await read('lifecycle.correction.inspect',{stageRequestId:second.request.id});assertNativeFacts(other,second);assert.equal(second.progress.phase,'FAILED');assert.equal(other.nativeEvidence.status,'AVAILABLE');assert.notEqual(second.request.id,id);assert.equal(other.facts.reason,view.facts.reason);assert(typeof view.facts.reason==='string'&&view.facts.reason.length>0);assert.notEqual(other.facts.inputDigest,view.facts.inputDigest);assert.notEqual(nativeHash(other.facts),nativeHash(view.facts));
  return{expected:'Same failure text retains distinct original baseline identity',actual:{reason:view.facts.reason,baselines:[view.facts.inputDigest,other.facts.inputDigest]},assertions:{distinctNativeBaselines:true}};
 }
 if(vector==='facts-vs-hypothesis'){
  assert(typeof view.proposal.input.hypothesis==='string'&&view.proposal.input.hypothesis.length>0);assert(!Object.hasOwn(view.facts,'hypothesis'));assert(!Object.hasOwn(view.facts,'minimalVerification'));
  return{expected:'Native facts remain separate from unverified proposal text',actual:{factsDigest:view.proposal.factsDigest,hypothesis:view.proposal.input.hypothesis},assertions:{hypothesisIsNotEvidence:true,executionAuthorized:false}};
 }
 const admission=await read('lifecycle.correction.admission',input);assertNativeFacts(admission,stage);assert.equal(admission.executionAuthorized,false);
 const repair=admission.repairAdmission;
 if(['preparation-defect','product-defect','transient-bounded'].includes(vector)){
  assert.equal(admission.allowed,true,'NOT_READY: current native minimal verification did not prove admission');assert.equal(repair.allowed,true);assert.equal(repair.executionAuthorized,false);assert.equal(repair.originalRequestId,id);assert.equal(repair.originalRequestDigest,stage.request.digest);
  const f=repair.facts;assert(f&&f.rounds.length>0,'NOT_READY: actual minimal verification rounds required');assert(view.captureHistory&&view.captureHistory.rounds.length>0,'NOT_READY: native repair capture required');
  for(const round of f.rounds){assert(view.captureHistory.rounds.some(r=>'runtime:repair-round/'+r.requestId===round.evidenceRef),'NOT_READY: verified round lacks original capture');}
  if(vector==='preparation-defect'){assert.equal(stage.request.plan.adapterId,'runtime-native-extension-stage-v1');assert.equal(f.schema,'runtime-stage-repair-facts/v1');assert.equal(f.failureClass,'DETERMINISTIC');assert.notEqual(f.before.dependencyClosureDigest,f.after.dependencyClosureDigest);assert.equal(f.before.sourceDigest,f.after.sourceDigest);assert.equal(f.before.candidateDigest,f.after.candidateDigest);}
  if(vector==='product-defect'){assert.equal(stage.request.plan.adapterId,'runtime-ci-owner-stage-v2');assert.equal(f.schema,'runtime-stage-repair-facts/v2');assert.equal(f.failureKind,'FIXED_PRODUCT_CHECK');assert(f.origins.some(o=>o.requestId===id&&o.requestDigest===stage.request.digest&&o.failedCriteria.length>0&&o.coverage.length===o.failedCriteria.length));}
  if(vector==='transient-bounded'){
   assert.equal(f.failureClass,'TRANSIENT');const retry=await loadOriginal(binding.retry,true),r=retry.request,prior=retry.repairAdmission;
   assert.notEqual(r.id,id);assert(prior,'NOT_READY: historical governed retry admission required');assert.equal(prior.requestId,r.id);assert.equal(prior.requestDigest,r.digest);assert.equal(prior.facts.failureClass,'TRANSIENT');assert.equal(prior.factsDigest,nativeHash(prior.facts));assert.equal(r.authorityRef,stage.request.authorityRef);assert(Date.parse(r.deadlineAt)<=Date.parse(stage.request.deadlineAt));assert(Date.parse(repair.deadlineAt)<=Date.parse(stage.request.deadlineAt));
   if(prior.facts.schema==='runtime-stage-repair-facts/v2')assert(prior.facts.origins.some(o=>o.requestId===id&&o.requestDigest===stage.request.digest));else{assert.equal(r.instanceId,stage.request.instanceId);assert.equal(r.stageId,stage.request.stageId);assert(Date.parse(r.requestedAt)>Date.parse(stage.request.requestedAt));}
   const before=await read('lifecycle.instance.inspect',{instanceId:stage.request.instanceId}),after=await read('lifecycle.instance.inspect',{instanceId:r.instanceId});
   assert.equal(before.instance.pinsDigest,stage.request.pinsDigest);assert.equal(after.instance.pinsDigest,r.pinsDigest);assert(before.instance.requestIds.includes(id)&&after.instance.requestIds.includes(r.id));
   for(const key of ['goalRef','targetRef','loopRef','authorityDigest'])assert.equal(after.instance.pins[key],before.instance.pins[key]);
   for(const key of ['maxAttempts','timeoutSeconds','maxConcurrency','maxLoops']){assert(Number.isSafeInteger(after.instance.pins.budget[key])&&after.instance.pins.budget[key]>0);assert(after.instance.pins.budget[key]<=before.instance.pins.budget[key]);}
   assert(after.instance.stages[r.stageId].attempts<=after.instance.pins.budget.maxAttempts);assert(Date.parse(r.deadlineAt)<=Date.parse(after.instance.pins.authorityExpiresAt));
   if(r.instanceId!==stage.request.instanceId){assert(before.recovery?.rootRef&&before.recovery.rootDigest);assert.equal(after.recovery.rootRef,before.recovery.rootRef);assert.equal(after.recovery.rootDigest,before.recovery.rootDigest);}

  }
  return{expected:vector==='transient-bounded'?'Native transient preview and retained retry inherit the original cutoff':vector==='preparation-defect'?'Native missing-prerequisite verifier proves repaired preparation inputs':'Native fixed product policy covers the original failed criteria',actual:{facts:f,deadlineAt:repair.deadlineAt,historicalRetryObserved:vector==='transient-bounded',newRetryDispatched:false},assertions:{nativeMinimalVerification:true,hypothesisCertified:false,newDispatches:0}};
 }
 const allowedReasons=vector==='unchanged-deterministic'?['UNCHANGED_DETERMINISTIC_FAILURE','REPAIR_ORIGIN_UNPROVEN']:vector==='two-no-progress'?['TWO_NO_PROGRESS_ROUNDS']:['REPAIR_EVIDENCE_REQUIRED','REPAIR_FAILURE_UNKNOWN','REPAIR_VERIFIER_UNAVAILABLE','REPAIR_ORIGIN_UNPROVEN'];
 assert.equal(admission.allowed,false);assert(repair&&repair.allowed===false,'NOT_READY: native repair assessment was not reached');assert(repair.reasons.some(r=>allowedReasons.includes(r)),'NOT_READY: wrong native refusal');
 if(vector==='two-no-progress')assert(view.captureHistory?.rounds.length>=2,'NOT_READY: two actual native rounds required');
 // V2 REPAIR_ORIGIN_UNPROVEN also means incomplete coverage; it cannot by
 // itself prove unchanged deterministic inputs.
 if(vector==='unchanged-deterministic')assert(repair.reasons.includes('UNCHANGED_DETERMINISTIC_FAILURE'),'NOT_READY: ambiguous v2 rejection does not prove unchanged inputs');
 return{expected:vector==='unproven'?'Unproven hypothesis cannot admit retry':vector==='two-no-progress'?'Two native no-progress rounds stop repair':'Identical deterministic inputs cannot admit retry',actual:{reasons:repair.reasons,roundCount:view.captureHistory?.rounds.length??0},assertions:{nativeRefusalObserved:true,newDispatches:0}};
}
async function collectLcNative(selection,catalog,installed,plan){
 const config=validateLcNativeSelection(JSON.parse(pinned(selection.lcNative)),selection);assert.equal(config.workspaceId,plan.workspaceId);assert.equal(config.projectId,plan.projectId);
 const manifest=verifyLc01InstalledBytes(selection.installedRoot,selection.expectedManifestDigest),clientModule=await import(pathToFileURL(path.join(selection.installedRoot,'package/dist/host/client.js')).href),connectionRef=path.join(selection.installedRoot,'connection.json'),client=clientModule.createRuntimeHttpClient(connectionRef),identity=await client.status();
 assert.equal(client.connection.serviceId,installed.serviceId);assert.equal(client.connection.workspaceId,config.workspaceId);assert.equal(client.connection.projectId,config.projectId);
 // Resolve every original protected pin before creating output or calling any
 // workflow endpoint. Missing fixtures are NOT_READY, never synthetic results.
 const originals=new Map();for(const v of Object.values(config.vectors))for(const role of ['original','second','retry'])if(v[role])originals.set(v[role].record.ref,JSON.parse(pinned(v[role].record)));
 const output=selection.outputRoot;assert(path.isAbsolute(output)&&path.resolve(output)===output&&!fs.existsSync(output));assert.equal(fs.realpathSync(path.dirname(output)),path.dirname(output));assert(!output.startsWith(selection.sourceRoot+path.sep)&&!output.startsWith(selection.installedRoot+path.sep));fs.mkdirSync(output,{mode:0o700});
 const candidate={manifestDigest:selection.expectedManifestDigest,archiveDigest:manifest.archiveDigest,version:manifest.version,serviceId:installed.serviceId,workspaceId:plan.workspaceId,projectId:plan.projectId},candidateDigest='sha256:'+candidate.manifestDigest;
 const save=(leaf,value)=>fs.writeFileSync(path.join(output,leaf),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});let seq=0;
 const artifact=(caseId,vectorId,label,value)=>{const leaf=String(++seq).padStart(4,'0')+'-'+label+'.json';save(leaf,value);return{caseInstanceId:caseId,vectorId,artifact:leaf,fileDigest:sha(regular(path.join(output,leaf)))}};
 const selected={scenario:'LC',sourceCommit:selection.sourceCommit,phase:selection.phase,addendumDigest:sha(regular(path.join(selection.sourceRoot,'governance/lifecycle-correction-v090.json'))),qualification:selection.qualification,candidate,candidateDigest,collectorPins:{'correction.test.mjs':sha(regular(self))},selectedCaseIds:selection.caseIds};save('selection.json',selected);
 const setupEvidence=[artifact(null,null,'native-setup',{config,selection,installed,identity,readOnly:true,budget:{maxWorkflowRequests:36,maxIdentityReads:37,deadlineSeconds:540},productAcceptance:'NOT_EVALUATED'})],rows=[],start=Date.now();let calls=0,stopped=false;
 for(const vector of LC_NATIVE_VECTORS[config.caseId]){
  const evidence=[],started=Date.now();let vectorCalls=0,result,status='FAILED';
  try{
   assert(!stopped,'NOT_READY: previous vector failed; no further service calls');
   const read=async(operation,input)=>{
    assert(['lifecycle.stage.request.inspect','lifecycle.correction.inspect','lifecycle.correction.admission','lifecycle.instance.inspect'].includes(operation));assert(++calls<=36&&++vectorCalls<=12&&Date.now()-start<540000&&Date.now()-started<180000,'Native collector budget exhausted');pinned(selection.lcNative);
    const envelope={operation,projectId:config.projectId,input};evidence.push(artifact(config.caseId,vector,'request',envelope));
    // Use installed identity/authentication helpers and retain literal HTTP
    // bytes as well as parsed readback; credentials never enter artifacts.
    const signal=AbortSignal.timeout(Math.max(1,Math.min(30000,180000-(Date.now()-started),540000-(Date.now()-start))));await client.status(signal);
    assert.deepEqual(clientModule.readHostConnection(connectionRef),client.connection);
    const rawRequest=JSON.stringify(envelope),response=await fetch(client.connection.origin+'/api/v1/request',{method:'POST',headers:{...clientModule.hostHeaders(client.connection),'content-type':'application/json'},body:rawRequest,signal,redirect:'error'});
    assert(response.headers.get('content-type')?.startsWith('application/json')&&response.body);const reader=response.body.getReader(),chunks=[];let bytes=0;
    try{for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.length;assert(bytes<=4194304,'Native HTTP evidence exceeds bound');chunks.push(item.value);}}catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
    const rawBody=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));evidence.push(artifact(config.caseId,vector,'response',{operation,input,status:response.status,rawRequest,rawBody}));const body=JSON.parse(rawBody);assert.equal(response.status,200,'Native public read failed');assert(typeof body.requestId==='string');exact(body,['requestId','result']);return body.result;
   };
   const loadOriginal=async (binding,retry=false)=>{const pinnedOriginal=JSON.parse(pinned(binding.record));assert.deepEqual(pinnedOriginal,originals.get(binding.record.ref));evidence.push(artifact(config.caseId,vector,'original-pin',{binding,original:pinnedOriginal}));return assertLcNativeOriginal(await read('lifecycle.stage.request.inspect',{stageRequestId:binding.stageRequestId}),pinnedOriginal,config,binding.stageRequestId,retry?['FAILED','COMPLETE']:['FAILED','UNKNOWN']);};
   result=await observeLcNativeVector(config.caseId,vector,config.vectors[vector],read,loadOriginal);status='PASS';
  }catch(error){stopped=true;result={expected:catalog.find(c=>c.id===config.caseId).expected,actual:{code:error.code??'NOT_READY_OR_ASSERTION_FAILED',message:error.message},assertions:{nativeVectorCompleted:false,newDispatches:0}};}
  evidence.push(artifact(config.caseId,vector,'expected-actual',result));rows.push({vectorId:vector,phase:selection.phase,status,qualification:selection.qualification,candidateDigest,assertions:result.assertions,evidence});
 }
 let integrity=true;try{pinned(selection.lcNative);pinned(selection.sourceRevision);verifyLc01InstalledBytes(selection.installedRoot,selection.expectedManifestDigest);execFileSync('git',['-C',selection.sourceRoot,'diff','--quiet',selection.sourceCommit,'--'],{stdio:'pipe'});for(const v of Object.values(config.vectors))for(const role of ['original','second','retry'])if(v[role])pinned(v[role].record);}catch(error){integrity=false;setupEvidence.push(artifact(null,null,'integrity-failure',{message:error.message}));}
 const result={caseInstanceId:config.caseId,phase:selection.phase,status:integrity&&rows.every(r=>r.status==='PASS')?'PASS':'FAILED',qualification:selection.qualification,candidateDigest,assertions:{allFixedVectorsObserved:rows.every(r=>r.status==='PASS'),integrityReadbackPassed:integrity,newDispatches:0},vectors:rows};save(config.caseId+'.json',result);save('REPORT.json',{schema:'runtime-correction-acceptance-report/v1',scenario:'LC',sourceCommit:selection.sourceCommit,phase:selection.phase,candidate,candidateDigest,selectionDigest:sha(regular(path.join(output,'selection.json'))),qualification:selection.qualification,...correctionCounts(catalog,selection.caseIds,[result]),setupEvidence,results:[result],productAcceptance:'NOT_EVALUATED',releaseAuthorized:false});assert.equal(result.status,'PASS','Native correction lane failed or NOT_READY');return output;
}
export async function collectCorrection(selectionRef){
 const selection=JSON.parse(regular(selectionRef,1048576,true));exact(selection,['schema','sourceRoot','sourceCommit','sourceRevision','phase','caseIds','installedRoot','expectedManifestDigest','qualification','outputRoot',...(selection.lc20===undefined?[]:['lc20']),...(selection.lc01===undefined?[]:['lc01']),...(selection.lcNative===undefined?[]:['lcNative'])]);assert.equal(selection.schema,'runtime-correction-acceptance-selection/v1');assert(/^[a-f0-9]{40}$/.test(selection.sourceCommit));assert(['DEVELOPMENT','FINAL_CANDIDATE'].includes(selection.qualification));assert.equal(process.version,'v24.14.0');assert.equal(pinned(selection.sourceRevision).toString().trim(),selection.sourceCommit);
 const sourceRoot=fs.realpathSync(selection.sourceRoot);assert.equal(sourceRoot,selection.sourceRoot);assertCorrectionEntryLocation(sourceRoot);const git=args=>execFileSync('git',['-C',sourceRoot,...args],{maxBuffer:33554432,encoding:null});assert.equal(git(['rev-parse','HEAD']).toString().trim(),selection.sourceCommit);
 const sourceFiles=git(['ls-files','-z']).toString().split('\0').filter(Boolean),sourcePins={};assert(sourceFiles.length>0&&sourceFiles.length<=10000);for(const f of sourceFiles){assert(!path.isAbsolute(f)&&!f.split('/').includes('..'));const bytes=regular(path.join(sourceRoot,f));assert.equal(sha(bytes),sha(git(['show',selection.sourceCommit+':'+f])),'Source differs from exact selected commit: '+f);sourcePins[f]=sha(bytes);}
 assert.equal(sha(regular(self)),sourcePins['tests/acceptance/v090/correction.test.mjs']);const addendumBytes=regular(path.join(sourceRoot,'governance/lifecycle-correction-v090.json')),catalog=correctionCatalog(JSON.parse(addendumBytes),selection.phase);validateCorrectionCases(catalog,selection.caseIds);
 const installedRoot=fs.realpathSync(selection.installedRoot);assert.equal(installedRoot,selection.installedRoot);if(selection.caseIds.includes('LC01')||selection.caseIds.some(id=>LC_NATIVE_VECTORS[id])){assert(!process.execArgv.some(a=>/loader|--import|--require|^-r$/.test(a))&&!process.env.NODE_OPTIONS,'LC01 installed execution forbids module substitution');assert(selection.caseIds.includes('LC01')?selection.lc01:selection.lcNative,'Native lane requires real protected fixture configuration');verifyLc01InstalledBytes(installedRoot,selection.expectedManifestDigest);}const {inspectInstalledServiceSelection}=await import(pathToFileURL(path.join(installedRoot,'package/dist/installation/service-control.js')).href),installed=inspectInstalledServiceSelection(installedRoot),manifestBytes=regular(path.join(installedRoot,'distribution-manifest.json')),manifest=JSON.parse(manifestBytes),plan=JSON.parse(regular(path.join(installedRoot,'installation-plan.json'),1048576,true));assert.equal(sha(manifestBytes),selection.expectedManifestDigest);assert.equal(installed.distributionManifestDigest,selection.expectedManifestDigest);assert.equal(plan.distribution.manifestDigest,selection.expectedManifestDigest);assert.equal(plan.nodeExecutable,fs.realpathSync(process.execPath));assert.equal(plan.nodeSha256,hashExecutable(fs.realpathSync(process.execPath)).sha256);if(selection.qualification==='FINAL_CANDIDATE')assert.equal(manifest.version,'0.9.0');
 for(const [f,pin]of Object.entries(manifest.files))if(f.startsWith('src/'))assert.equal(sourcePins[f],pin.sha256,'Installed candidate source differs from selected owner repository');
 if(selection.caseIds.some(id=>LC_NATIVE_VECTORS[id]))return collectLcNative(selection,catalog,installed,plan);
 if(selection.caseIds.includes('LC01'))return collectLc01(selection,catalog,installed,plan);
 if(selection.caseIds.includes('LC20')){
  assert.deepEqual(selection.caseIds,['LC20'],'The resumable LC20 lane has its own original claim; run other fixed cases in their retained lanes');assert.equal(selection.phase,'PRE_RELEASE');assert(selection.lc20,'Select the exact protected controller configuration');const config=JSON.parse(pinned(selection.lc20));for(const key of ['sourceRoot','sourceCommit','installedRoot','outputRoot'])assert.equal(config[key],selection[key]);assert.equal(config.candidateDigest,'sha256:'+selection.expectedManifestDigest);const result=await collectLc20Controller(config),results=result.status==='COMPLETE'?[{schema:'runtime-correction-case-result/v1',scenario:'LC',caseInstanceId:'LC20',sourceCommit:selection.sourceCommit,phase:selection.phase,candidateDigest:config.candidateDigest,status:'PASS',startedAt:result.rawReceipt.startedAt,completedAt:result.rawReceipt.completedAt,vectorIds:[...LC20_VECTORS],assertions:{allFourVectorsExecuted:true,subordinateFormalCredit:0},rawReceipt:result.receipt}]:[];
  const report={schema:'runtime-correction-acceptance-report/v1',scenario:'LC',sourceCommit:selection.sourceCommit,phase:selection.phase,candidateDigest:config.candidateDigest,qualification:selection.qualification,...correctionCounts(catalog,selection.caseIds,results),controller:result,productAcceptance:'NOT_EVALUATED',releaseAuthorized:false,results},bytes=JSON.stringify(report,null,2)+'\n',original=path.join(selection.outputRoot,'REPORT-'+sha(bytes)+'.json');if(!fs.existsSync(original))fs.writeFileSync(original,bytes,{mode:0o600,flag:'wx'});fs.writeFileSync(path.join(selection.outputRoot,'REPORT.json'),bytes,{mode:0o600});return selection.outputRoot;
 }
 const lockBytes=regular(path.join(sourceRoot,'package-lock.json')),closure=toolClosure(sourceRoot,JSON.parse(lockBytes)),toolRoot=fs.realpathSync(path.join(sourceRoot,'node_modules/dependency-cruiser'));assert.equal(closure.get(toolRoot).version,'18.7.2');const driver=regular(path.join(sourceRoot,'scripts/correction-tooling.mjs')),launcher='bin/dependency-cruiser.mjs',originalLauncher=regular(path.join(toolRoot,launcher));
 const output=selection.outputRoot;assert(path.isAbsolute(output)&&path.resolve(output)===output&&!fs.existsSync(output));assert.equal(fs.realpathSync(path.dirname(output)),path.dirname(output));assert(!output.startsWith(sourceRoot+path.sep)&&!output.startsWith(installedRoot+path.sep));fs.mkdirSync(output,{mode:0o700});let sequence=0;const results=[],setupEvidence=[];const save=(leaf,value)=>fs.writeFileSync(path.join(output,leaf),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'}),artifact=(caseId,vectorId,label,value)=>{const leaf=String(++sequence).padStart(5,'0')+'-'+label+'.json';save(leaf,value);return{caseInstanceId:caseId,vectorId,artifact:leaf,fileDigest:sha(fs.readFileSync(path.join(output,leaf)))}};
 const candidate={manifestDigest:sha(manifestBytes),archiveDigest:manifest.archiveDigest,version:manifest.version,serviceId:installed.serviceId,workspaceId:plan.workspaceId,projectId:plan.projectId},candidateDigest='sha256:'+candidate.manifestDigest,recorded={scenario:'LC',sourceCommit:selection.sourceCommit,phase:selection.phase,addendumDigest:sha(addendumBytes),qualification:selection.qualification,candidate,candidateDigest,collectorPins:{'correction.test.mjs':sha(regular(self))},selectedCaseIds:selection.caseIds};save('selection.json',recorded);
 setupEvidence.push(artifact(null,null,'exact-bindings',{selection,installed,candidate,sourcePins,driverSha256:sha(driver),lockSha256:sha(lockBytes),node:{...hashExecutable(fs.realpathSync(process.execPath)),version:process.version},toolPackages:[...closure].map(([root,pin])=>({root,...pin})),unimplementedCollectors:catalog.filter(c=>c.id!=='LC21').map(c=>c.id),sourceControlledFaults:LC21_FAULTS,childEnvironmentIdentity:{policy:'LC21-fixed-allowlist/v1',keys:['PATH','LANG','LC_ALL','NODE_OPTIONS','TMPDIR','PYTHONDONTWRITEBYTECODE','NO_COLOR','FORCE_COLOR'],locale:'C',nodeOptionsEmpty:true,pathPolicy:'selected-node directory plus /usr/bin:/bin',temporaryDirectoryPolicy:'owned vector lane'},productAcceptance:'NOT_EVALUATED',releaseAuthorized:false}));
 const deadline=Date.now()+300000;
 try{
 if(selection.phase==='PRE_RELEASE'&&selection.caseIds.includes('LC21')){
  const rows=[];for(const vector of vectors){const evidence=[],lane=path.join(output,'LC21-'+vector);let status='PASS',assertions,invoked=false;try{
   assert(Date.now()<deadline-10000);assert.equal(hashExecutable(fs.realpathSync(process.execPath)).sha256,plan.nodeSha256);for(const f of sourceFiles)assert.equal(sha(regular(path.join(sourceRoot,f))),sourcePins[f]);for(const [root,pkg]of closure)assert.deepEqual(snapshotTree(root),pkg.pins);fs.mkdirSync(lane,{mode:0o700});const repo=path.join(lane,'repository');fs.mkdirSync(repo);for(const f of sourceFiles){const to=path.join(repo,f);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(sourceRoot,f),to);}
   fs.mkdirSync(path.join(repo,'node_modules'));for(const [root,pkg]of closure){if(root===toolRoot)continue;const relative=path.relative(path.join(sourceRoot,'node_modules'),root);if(relative.split(path.sep).includes('node_modules'))continue;const to=path.join(repo,'node_modules',relative);if(fs.existsSync(to))continue;fs.mkdirSync(path.dirname(to),{recursive:true});fs.symlinkSync(root,to,'dir');}
   const privateTool=path.join(repo,'node_modules/dependency-cruiser');fs.cpSync(toolRoot,privateTool,{recursive:true,errorOnExist:true,force:false});const fault=LC21_FAULTS[vector]??null;if(fault)fs.writeFileSync(path.join(privateTool,launcher),fault);const launcherBytes=regular(path.join(privateTool,launcher)),modifiedPins=snapshotTree(privateTool);
   assert.equal(sha(regular(path.join(repo,'scripts/correction-tooling.mjs'))),sha(driver));for(const [f,pin]of Object.entries(closure.get(toolRoot).pins))if(f!==launcher||!fault)assert.deepEqual(modifiedPins[f],pin);assert.equal(Object.keys(modifiedPins).length,Object.keys(closure.get(toolRoot).pins).length);if(fault)assert.notEqual(sha(launcherBytes),sha(originalLauncher));else assert.equal(sha(launcherBytes),sha(originalLauncher));
   evidence.push(artifact('LC21',vector,'lane-bindings',{faultInjected:!!fault,fixtureSource:fault,originalLauncherSha256:sha(originalLauncher),executedLauncherSha256:sha(launcherBytes),upstreamPackageIdentityPreserved:!fault,originalToolPackagePins:closure.get(toolRoot),executedToolPackagePins:modifiedPins,readOnlyDependencies:[...closure].filter(([root])=>root!==toolRoot).map(([root,p])=>({root,...p})),sourcePins,adapterUnchanged:true,candidateUnchanged:true}));
   const tmp=path.join(lane,'tmp');fs.mkdirSync(tmp,{mode:0o700});const raw=await execute(process.execPath,[path.join(repo,'scripts/correction-tooling.mjs'),'graph'],repo,{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',LANG:'C',LC_ALL:'C',NODE_OPTIONS:'',TMPDIR:tmp,PYTHONDONTWRITEBYTECODE:'1',NO_COLOR:'1',FORCE_COLOR:'0'},Math.max(1,Math.min(75000,deadline-Date.now()-10000)));invoked=true;evidence.push(artifact('LC21',vector,'raw-command',raw));const parsed=parseLC21Driver(raw,vector);assert(Object.keys(parsed.sourceHashes).length>0);for(const [f,pin]of Object.entries(parsed.sourceHashes))assert.equal(sourcePins[f],pin,'Executed driver source differs from exact source snapshot');assert(parsed.artifactDirectory.startsWith(tmp+path.sep));assert.equal(fs.realpathSync(parsed.artifactDirectory),parsed.artifactDirectory);const graph=JSON.parse(regular(path.join(parsed.artifactDirectory,'graph.json'))),resultBytes=regular(path.join(parsed.artifactDirectory,'result.json'));assert.deepEqual(JSON.parse(resultBytes),parsed);
   if(fault){assert.equal(graph.code,vector==='command-fail'?23:0);assert.equal(graph.signal,null);assert.equal(graph.exceeded,null);assert.equal(graph.stdout,vector==='cli-protocol-mismatch'?JSON.stringify({lc21WrongProtocol:true}):'');assert.equal(graph.stderr,vector==='command-fail'?'LC21 controlled command failure\n':'');}else{const graphValue=JSON.parse(graph.stdout);assert.equal(graph.code,0);assert(Array.isArray(graphValue.modules)&&graphValue.summary.error===0);}
   evidence.push(artifact('LC21',vector,'driver-artifacts',{graph,driverResult:parsed,resultBytesBase64:resultBytes.toString('base64')}));assertions={actualCommandExecuted:true,faultInjected:!!fault,expectedAdapterOutcome:parsed.status,rawExitCode:raw.code,toolExitCode:graph.code,costStatus:parsed.costStatus,tokenUsage:null,monetaryCost:null,independentInvocation:true,productAcceptance:'NOT_EVALUATED'};
  }catch(error){status='FAILED';assertions={actualCommandExecuted:invoked,error:{message:error.message,stack:error.stack},noAcceptanceInferred:true};evidence.push(artifact('LC21',vector,'failure',assertions));}rows.push({vectorId:vector,phase:selection.phase,status,qualification:selection.qualification,candidateDigest,assertions,evidence});}
  const result={caseInstanceId:'LC21',phase:selection.phase,status:rows.every(r=>r.status==='PASS')?'PASS':'FAILED',qualification:selection.qualification,candidateDigest,assertions:{allFourFixedVectorsExecuted:rows.length===4&&rows.every(r=>r.assertions.actualCommandExecuted===true),allFourFixedVectorsPassed:rows.every(r=>r.status==='PASS'),toolObservationsOnly:true},vectors:rows};results.push(result);
 }
 }finally{
  let integrity=true;try{assert.equal(hashExecutable(fs.realpathSync(process.execPath)).sha256,plan.nodeSha256);for(const f of sourceFiles)assert.equal(sha(regular(path.join(sourceRoot,f))),sourcePins[f]);for(const [root,pkg]of closure)assert.deepEqual(snapshotTree(root),pkg.pins);assert.equal(sha(regular(self)),recorded.collectorPins['correction.test.mjs']);assert.deepEqual(inspectInstalledServiceSelection(installedRoot),installed);}catch(error){integrity=false;setupEvidence.push(artifact(null,null,'integrity-failure',{message:error.message,stack:error.stack}));}
  for(const result of results){if(!integrity){result.status='FAILED';result.assertions.integrityReadbackPassed=false;}save(result.caseInstanceId+'.json',result);}
  const report={schema:'runtime-correction-acceptance-report/v1',scenario:'LC',sourceCommit:selection.sourceCommit,phase:selection.phase,candidate,candidateDigest,selectionDigest:sha(fs.readFileSync(path.join(output,'selection.json'))),qualification:selection.qualification,...correctionCounts(catalog,selection.caseIds,results),productAcceptance:'NOT_EVALUATED',releaseAuthorized:false,setupEvidence,results};save('REPORT.json',report);
 }
 assert(selection.caseIds.every(id=>results.some(r=>r.caseInstanceId===id&&r.status==='PASS')),'Actual selected correction collector failed or remains unimplemented');return output;
}
if(process.argv[1]&&path.resolve(process.argv[1])===self)test('LC fixed original correction observations',async()=>{assert(process.env.EVOPILOT_V090_CORRECTION_SELECTION,'Select protected exact correction bindings');await collectCorrection(process.env.EVOPILOT_V090_CORRECTION_SELECTION);});
