import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, exact, record, reject, slug, string, ServiceError } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { valueDigest } from '../lifecycle/base.js';
import { nativeSha256, nativeStableSerialize, referenceForPackage, validateNativeReference, type NativePackage, type NativeReference, type NativeScope, type NativeToolchain } from '../../vendor/compatibility/v1/native.mjs';
import { READINESS_STANDARD_DIGEST, validateReadinessIntent, verifyReadinessProjection, type ReadinessIntentRecord, type ReadinessProjection } from '../../vendor/compatibility/usability/v2/contract.mjs';

export type Owner = 'ontology'|'harness';
const MANIFESTS = {
  ontology: '61d8047679d74ccf9f8a11e72a1f1ce06cf103348b46d0b06cd488f10faa1da5',
  harness: '9a878fb7862008895244ae27b8898301e58d1c1ad162753cc848c0ea1a963c31',
} as const;
type FilePin = {type:'file';sha256:string}|{type:'symlink';target:string};
interface Distribution {schema:string;owner:Owner;version:string;releaseUrl:string;packageDigest:string;dependencyLockDigest:string;files:Record<string,FilePin>;}
export interface OwnerConfiguration {owner:Owner;packageRoot:string;workspaceRoot:string;workspaceId:string;projects:string[];}
export interface OwnerRequest {operation:string;scope:NativeScope;input:Record<string,unknown>;requestId?:string;expectedRevision?:number;}
/** Constructed by the trusted execution layer for an already authorized exact
 * action. This is not an HTTP/YAML field or permission granted by an owner PASS. */
export interface OwnerMutationPermit {projectId:string;owner:Owner;requestDigest:string;expiresAt:string;authorityRef:string;}
interface OwnerService {
  initialize():unknown; close():void; capabilities():unknown;
  execute(request:unknown):unknown; native(request:unknown):Promise<unknown>;
  readiness(request:unknown):Promise<unknown>; feedback(request:unknown):Promise<unknown>;
}
export type OwnerIntentReader=(actor:Principal,projectId:string,request:{workspaceId:string;scope:NativeScope;digest:string})=>Promise<ReadinessIntentRecord&{current:boolean}>;
interface FactoryProviders {
  nativeToolchain?:NativeToolchain;
  resolveNativeDependency?:(request:{workspaceId:string;scope:NativeScope;reference:NativeReference})=>Promise<unknown>;
  readReadinessIntent?:(request:{workspaceId:string;scope:NativeScope;digest:string})=>Promise<ReadinessIntentRecord&{current:boolean}>;
  readReadinessProjection?:(request:{workspaceId:string;scope:NativeScope;reference:NativeReference})=>Promise<ReadinessProjection>;
}
type Factory=(options:{workspaceRoot:string;workspaceId:string},providers:FactoryProviders)=>OwnerService;
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
function canonicalDirectory(path:string):void{
  string(path,4096);if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path||!lstatSync(path).isDirectory()||(lstatSync(path).mode&0o022)!==0)reject('UNTRUSTED_OWNER_PATH','Use an existing canonical owner directory that is not group/world writable');
}
function trustedDistribution(owner:Owner):Distribution{
  if(!Object.hasOwn(MANIFESTS,owner))reject('UNSUPPORTED_OWNER','Unsupported asset owner');
  const path=new URL('../../provenance/published-owners/'+owner+'-0.8.3.json',import.meta.url),stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576)reject('UNTRUSTED_OWNER_MANIFEST','Invalid installed owner distribution manifest');
  const bytes=readFileSync(path);if(sha(bytes)!==MANIFESTS[owner])reject('UNTRUSTED_OWNER_MANIFEST','Installed owner distribution manifest has changed');
  return JSON.parse(bytes.toString('utf8')) as Distribution;
}
export function ownerDistributionIdentity(owner:Owner){
  const manifest=trustedDistribution(owner);
  return Object.freeze({owner,version:manifest.version,releaseUrl:manifest.releaseUrl,packageDigest:manifest.packageDigest,dependencyLockDigest:manifest.dependencyLockDigest,distributionDigest:'sha256:'+MANIFESTS[owner],files:Object.keys(manifest.files).length});
}
/** Verify all shipped files and installed production dependencies before import.
 * A package root is operator configuration; project YAML cannot select code. */
export function verifyOwnerDistribution(owner:Owner,packageRoot:string):Readonly<{owner:Owner;version:string;packageDigest:string;distributionDigest:string;files:number}>{
  const manifest=trustedDistribution(owner);canonicalDirectory(packageRoot);const found:string[]=[];
  function walk(directory:string):void{
    for(const name of readdirSync(directory)){
      const path=join(directory,name),key=relative(packageRoot,path).split(sep).join('/'),stat=lstatSync(path);
      if(stat.isDirectory()&&!stat.isSymbolicLink()){if((stat.mode&0o022)!==0)reject('UNTRUSTED_OWNER_PATH','Writable owner subdirectory');walk(path);continue;}
      const pin=manifest.files[key];if(!pin)reject('OWNER_DISTRIBUTION_CHANGED','Unlisted file in the owner distribution');found.push(key);
      if(stat.isSymbolicLink()){
        const target=readlinkSync(path),resolved=realpathSync(path);
        if(pin.type!=='symlink'||target!==pin.target||!resolved.startsWith(packageRoot+sep))reject('OWNER_DISTRIBUTION_CHANGED','Owner link does not match its distribution');
      }else if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o022)!==0||pin.type!=='file'||stat.size>33554432||sha(readFileSync(path))!==pin.sha256)reject('OWNER_DISTRIBUTION_CHANGED','Owner file does not match its distribution');
    }
  }
  walk(packageRoot);
  if(found.length!==Object.keys(manifest.files).length)reject('OWNER_DISTRIBUTION_CHANGED','Owner distribution has missing files');
  return Object.freeze({owner,version:manifest.version,packageDigest:manifest.packageDigest,distributionDigest:'sha256:'+MANIFESTS[owner],files:found.length});
}
const NATIVE_READS=['standard.inspect','native.package.inspect','native.package.list','native.package.readback','native.receipt.inspect'];
const FEEDBACK_READS=['feedback.inspect','feedback.list','feedback.read'];
const READINESS_READS={ontology:['readiness.standard.inspect','readiness.package.inspect','readiness.package.export','readiness.package.verify'],harness:['readiness.standard.inspect','readiness.inspect','readiness.assessment.read','readiness.assessment.version','readiness.assessment.list','readiness.receipt.inspect']};
function permittedRead(owner:Owner,operation:string):boolean{return NATIVE_READS.includes(operation)||FEEDBACK_READS.includes(operation)||READINESS_READS[owner].includes(operation)||operation==='workspace.inspect';}
function validateConfiguration(config:OwnerConfiguration):void{
  exact(record(config),['owner','packageRoot','workspaceRoot','workspaceId','projects']);slug(config.workspaceId);
  if(!Object.hasOwn(MANIFESTS,config.owner)||!Array.isArray(config.projects)||!config.projects.length||config.projects.length>1000||new Set(config.projects).size!==config.projects.length)reject('INVALID_OWNER_CONFIGURATION','Invalid owner project registration');
  config.projects.forEach(slug);canonicalDirectory(config.workspaceRoot);
  // initialize() is the owner's public connection entry. Require its existing
  // workspace/database first, so a read never bootstraps an absent owner store.
  for(const path of [join(config.workspaceRoot,'workspace.json'),join(config.workspaceRoot,'state',config.owner,config.owner+'.db')]){
    const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())reject('OWNER_NOT_INITIALIZED','Initialize the owner through its own workflow before registering it');
  }
}
export function ownerRequestDigest(owner:Owner,request:OwnerRequest):string{return valueDigest({owner,request});}
export interface PublishedOwnerAdapter {
  readonly owner:Owner; readonly workspaceId:string;
  capabilities():unknown;
  read(actor:Principal,projectId:string,request:OwnerRequest):Promise<unknown>;
  readPackage(actor:Principal,projectId:string,scope:NativeScope,reference:NativeReference):Promise<Record<string,unknown>>;
  mutate(actor:Principal,projectId:string,request:OwnerRequest,permit:OwnerMutationPermit):Promise<unknown>;
  close():void;
}
export async function openPublishedOwner(configuration:OwnerConfiguration,toolchain?:NativeToolchain,ontology?:PublishedOwnerAdapter,readIntent?:OwnerIntentReader):Promise<PublishedOwnerAdapter>{
  const config=JSON.parse(canonical(configuration)) as OwnerConfiguration;
  validateConfiguration(config);const identity=verifyOwnerDistribution(config.owner,config.packageRoot);
  const calls=new AsyncLocalStorage<{actor:Principal;projectId:string}>();
  const providers:FactoryProviders=toolchain?{nativeToolchain:toolchain}:{};
  if(config.owner==='harness'&&ontology){
    if(ontology.owner!=='ontology'||ontology.workspaceId!==config.workspaceId)reject('OWNER_SCOPE','Owner dependencies must share the configured workspace');
    providers.resolveNativeDependency=async request=>{
      const context=calls.getStore();if(!context||request.workspaceId!==config.workspaceId)reject('OWNER_SCOPE','Dependency resolution lacks current scoped request authority');
      await ontology.readPackage(context.actor,context.projectId,request.scope,request.reference);
      return{reference:request.reference,published:true,workspaceId:config.workspaceId,scope:request.scope};
    };
    providers.readReadinessProjection=async request=>{
      const context=calls.getStore();if(!context||request.workspaceId!==config.workspaceId)reject('OWNER_SCOPE','Readiness projection requires the current scoped owner call');
      await ontology.readPackage(context.actor,context.projectId,request.scope,request.reference);
      const projection=await ontology.read(context.actor,context.projectId,{operation:'readiness.package.inspect',scope:request.scope,input:{standardVersion:'v2',id:request.reference.id,version:request.reference.version}}) as ReadinessProjection;
      verifyReadinessProjection(projection);
      if(!projection.published||projection.workspaceId!==config.workspaceId||nativeStableSerialize(projection.scope)!==nativeStableSerialize(request.scope)||nativeStableSerialize(projection.reference)!==nativeStableSerialize(request.reference))reject('OWNER_REFERENCE_CHANGED','Readiness projection differs from the published asset binding');
      return projection;
    };
    if(readIntent)providers.readReadinessIntent=async request=>{
      const context=calls.getStore();if(!context||request.workspaceId!==config.workspaceId||request.scope.visibility==='private'&&request.scope.projectId!==context.projectId)reject('OWNER_SCOPE','Readiness intent requires the current scoped owner call');
      authorize(context.actor,context.projectId,'read');
      const intent=await readIntent(context.actor,context.projectId,request);validateReadinessIntent(intent.definition);
      if(intent.definition.workspaceId!==config.workspaceId||nativeStableSerialize(intent.definition.scope)!==nativeStableSerialize(request.scope)||intent.digest!==request.digest||nativeSha256(intent.definition)!==request.digest||typeof intent.current!=='boolean'||intent.authority!==false)reject('OWNER_REFERENCE_CHANGED','Readiness intent does not match its current exact Runtime record');
      return intent;
    };
  }
  const module=await import(pathToFileURL(join(config.packageRoot, 'dist/service.js')).href) as Record<string,unknown>;
  const factory=module[config.owner==='ontology'?'createOntologyService':'createHarnessService'];
  if(typeof factory!=='function')reject('OWNER_CAPABILITY','Published owner factory is missing');
  const service=(factory as Factory)({workspaceRoot:config.workspaceRoot,workspaceId:config.workspaceId},providers);
  let closed=false;
  try{const capabilities=record(service.capabilities());if(capabilities.product!==config.owner||capabilities.version!==identity.version)reject('OWNER_CAPABILITY','Owner identity does not match the selected Release');service.initialize();}
  catch(e){service.close();throw e;}
  function preflight(actor:Principal,projectId:string,request:OwnerRequest,permission:'read'|'execution.request'){
    if(closed)reject('CLOSED','Owner adapter is closed',503);authorize(actor,projectId,permission);
    if(!config.projects.includes(projectId))reject('OWNER_SCOPE','Project is not registered for this owner',403);
    exact(record(request.scope),['visibility','projectId']);slug(request.scope.projectId);
    if(!['private','public'].includes(request.scope.visibility)||request.scope.visibility==='private'&&request.scope.projectId!==projectId)reject('OWNER_SCOPE','Private owner scope does not match the requesting project',403);
    verifyOwnerDistribution(config.owner,config.packageRoot);
  }
  async function invoke(actor:Principal,projectId:string,request:OwnerRequest):Promise<unknown>{
    try{return await calls.run({actor,projectId},async()=>{
      if(request.operation.startsWith('native.')||request.operation==='standard.inspect')return service.native(request);
      if(request.operation.startsWith('readiness.'))return service.readiness(request);
      if(request.operation.startsWith('feedback.'))return service.feedback(request);
      return service.execute(request);
    });}catch(error){
      if(error instanceof ServiceError)throw error;
      const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)?error.code:'OWNER_FAILURE';
      throw new ServiceError(code,'Published '+config.owner+' operation did not complete; inspect its original receipt before retry',409);
    }
  }
  const read=async(actor:Principal,projectId:string,request:OwnerRequest)=>{
    exact(record(request),['operation','scope','input']);record(request.input);string(request.operation);
    if(!permittedRead(config.owner,request.operation))reject('OWNER_OPERATION_FORBIDDEN','Runtime consumer cannot author, approve or publish owner assets',403);
    preflight(actor,projectId,request,'read');return invoke(actor,projectId,request);
  };
  const readPackage=async(actor:Principal,projectId:string,scope:NativeScope,reference:NativeReference)=>{
    validateNativeReference(reference,{product:config.owner});
    if(reference.visibility!==scope.visibility)reject('OWNER_SCOPE','Asset reference visibility differs from its scope');
    const output=record(await read(actor,projectId,{operation:'native.package.readback',scope,input:{id:reference.id,version:reference.version}}));
    if(!output.reference||nativeStableSerialize(output.reference)!==nativeStableSerialize(reference)||nativeStableSerialize(referenceForPackage(output.package as NativePackage))!==nativeStableSerialize(reference))reject('OWNER_REFERENCE_CHANGED','Owner readback does not match the exact selected asset');
    if(config.owner==='harness'&&output.published!==true||config.owner==='ontology'&&!output.reference)reject('OWNER_NOT_PUBLISHED','Only a published owner package may be bound');
    if(config.owner==='harness'&&output.workspaceId!==config.workspaceId||config.owner==='ontology'&&record(output.workspace).id!==config.workspaceId||nativeStableSerialize(output.scope)!==nativeStableSerialize(scope))reject('OWNER_SCOPE','Owner readback context differs from the requested scope');
    return output;
  };
  return Object.freeze({owner:config.owner,workspaceId:config.workspaceId,
    capabilities:()=>({...identity,readOperations:[...NATIVE_READS,...FEEDBACK_READS,...READINESS_READS[config.owner],'workspace.inspect'],mutationOperations:['native.package.validate',...(config.owner==='ontology'?['native.package.reconcile']:[]),'feedback.ingest'],authoring:false,assetPublication:false,softwareRelease:false}),
    read,readPackage,
    async mutate(actor:Principal,projectId:string,request:OwnerRequest,permit:OwnerMutationPermit){
      exact(record(request),['operation','scope','input','requestId','expectedRevision']);record(request.input);string(request.requestId);
      if(!['native.package.validate',...(config.owner==='ontology'?['native.package.reconcile']:[]),'feedback.ingest'].includes(request.operation))reject('OWNER_OPERATION_FORBIDDEN','Runtime consumer cannot author, approve or publish owner assets',403);
      exact(record(permit),['projectId','owner','requestDigest','expiresAt','authorityRef']);string(permit.authorityRef,512);
      if(permit.projectId!==projectId||permit.owner!==config.owner||permit.requestDigest!==ownerRequestDigest(config.owner,request)||!Number.isFinite(Date.parse(permit.expiresAt))||Date.parse(permit.expiresAt)<=Date.now())reject('OWNER_AUTHORITY_REQUIRED','Exact current owner validation/feedback authority is required',403);
      if(!Number.isSafeInteger(request.expectedRevision)||Number(request.expectedRevision)<0)reject('INVALID_REVISION','Owner CAS revision is required');
      preflight(actor,projectId,request,'execution.request');return invoke(actor,projectId,request);
    },
    close(){if(!closed){closed=true;service.close();}},
  });
}

/** Verify the public, freshly recomputed Harness view, not a historical version
 * or caller-provided grade. Content readiness never proves software equivalence.
 * Synthetic origins remain explicit and cannot satisfy an ACTUAL requirement. */
export function verifyReadinessView(value:unknown,projection:ReadinessProjection,minimum:'L1'|'L2'|'L3',origin:'ACTUAL'|'SYNTHETIC'):{level:'L1'|'L2'|'L3';assessmentDigest:string;recordedDigest:string;projectionDigest:string;evidenceOrigin:'ACTUAL'|'SYNTHETIC';meaning:'ASSET_CONTENT_ONLY';softwareRelease:false}{
  verifyReadinessProjection(projection);
  const view=record(value);exact(view,['recordedDigest','result','currentViewDigest','authority']);const result=record(view.result),{digest,...body}=result;
  const equal=(a:unknown,b:unknown)=>nativeStableSerialize(a)===nativeStableSerialize(b);
  if(!['L1','L2','L3'].includes(minimum)||!['ACTUAL','SYNTHETIC'].includes(origin)||view.authority!==false||typeof view.recordedDigest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(view.recordedDigest)||view.currentViewDigest!==nativeSha256(result)||digest!==nativeSha256(body)||result.schema!=='evopilot-asset-readiness-result/v2'||result.standardVersion!=='v2'||result.standardDigest!==READINESS_STANDARD_DIGEST||result.authority!==false||result.softwareRelease!==false||!projection.published||result.workspaceId!==projection.workspaceId||!equal(result.scope,projection.scope)||!equal(result.reference,projection.reference)||result.projectionDigest!==projection.digest||result.specificationDigest!==projection.specificationDigest||result.intentDigest!==projection.specification.intentDigest||result.targetLevel!==projection.specification.intent.targetLevel)reject('ASSET_READINESS_INTEGRITY','Current asset readiness does not match the exact published projection',409);
  const grade=record(result.assetAssessment),levels=['L1','L2','L3'];
  if(grade.status!=='QUALIFIED'||grade.freshness!=='CURRENT'||grade.level!==result.targetLevel||levels.indexOf(String(grade.level))<levels.indexOf(minimum)||grade.evidenceOrigin!==origin||!Array.isArray(grade.gaps)||grade.gaps.length||!Number.isSafeInteger(grade.required)||Number(grade.required)<1||typeof grade.reviewDigest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(grade.reviewDigest))reject('ASSET_NOT_READY','Asset content is missing, stale, insufficiently reviewed or below the required level',409);
  return{level:grade.level as 'L1'|'L2'|'L3',assessmentDigest:String(digest),recordedDigest:view.recordedDigest,projectionDigest:projection.digest,evidenceOrigin:origin,meaning:'ASSET_CONTENT_ONLY',softwareRelease:false};
}
