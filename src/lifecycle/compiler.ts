import { parseDocument, isAlias, isNode, visit } from 'yaml';
import { canonical, record, ServiceError } from '../server/errors.js';
import { byteDigest, loadPublisherBase, valueDigest, type BasePin, type FieldRule } from './base.js';

export interface Issue { code:string; path:string; rule:string; message:string; remedy:string; }
export interface EffectiveNode { id:string; source:'base'|'project'; stage:string; required:true; dependsOn:string[]; checks:string[]; action?:Record<string,unknown>; }
export interface EffectiveDefinition { schema:'runtime-effective-lifecycle/v1'; projectId:string; base:BasePin; semanticDigest:string; semantic:Record<string,unknown>; nodes:EffectiveNode[]; fieldSources:Record<string,string>; }
export interface Compilation { valid:boolean; issues:Issue[]; sourceDigest:string; presentationDigest:string|null; effective:EffectiveDefinition|null; }
export const bindingPattern=/^binding:[a-z0-9][a-z0-9._/-]{0,127}$/;
const credentialPattern=/^credential:[a-z0-9][a-z0-9._/-]{0,127}$/;
const projectNode=/^project\.[a-z][a-z0-9-]{0,62}$/;
const placeholder=/^(?:todo|tbd|n\/?a|unknown|placeholder|skip|latest|<[^>]*>)$/i;
export function atPath(value:unknown,path:string):unknown {let current=value;for(const p of path.split('.')){if(!current||typeof current!=='object'||Array.isArray(current)||!Object.hasOwn(current,p))return undefined;current=(current as Record<string,unknown>)[p];}return current;}
function plain(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));}
function relativePath(v:unknown):boolean{return typeof v==='string'&&v.length>0&&v.length<=512&&!v.startsWith('/')&&!v.includes('\\')&&!v.includes('://')&&!v.split('/').some(x=>!x||x==='.'||x==='..')&&!/[\u0000-\u001f?#]/.test(v);}
export function containsInlineSecret(source:string):boolean {return /\b(?:glpat-|gh[pousr]_|sk-(?:proj-)?)[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9_-]{24,}|(?:^|[\n{,])\s*["']?(?:password|api[_-]?key|access[_-]?token|secret|token)["']?\s*:\s*[^\s#]/i.test(source);}

export function compileLifecycle(source:string,projectId:string):Compilation {
  const issues:Issue[]=[];
  const issue=(code:string,path:string,rule:string,message:string,remedy='Correct this field using the publisher schema; keep the previous active revision until validation succeeds.')=>{if(issues.length<128)issues.push({code,path,rule,message,remedy});};
  const result:Compilation={valid:false,issues,sourceDigest:byteDigest(typeof source==='string'?source:''),presentationDigest:null,effective:null};
  if(typeof source!=='string'||Buffer.byteLength(source)>262144){issue('YAML_LIMIT','$','yaml.maxBytes','YAML must be at most 256 KiB');return result;}
  if(containsInlineSecret(source)){issue('INLINE_SECRET','$','credential-reference-only','Use protected credential references, not secret values');return result;}
  let data:Record<string,unknown>;
  try{
    const document=parseDocument(source,{version:'1.2',strict:true,uniqueKeys:true,stringKeys:true,keepSourceTokens:true,prettyErrors:false});
    if(document.errors.length||document.warnings.length){for(const e of [...document.errors,...document.warnings])issue('YAML_PARSE','$','yaml.syntax',e.code);return result;}
    if(document.directives?.yaml.version!=='1.2')issue('YAML_VERSION','$','yaml.version','Only YAML 1.2 is supported');
    visit(document,(_key,node,path)=>{
      if(path.length>32){issue('YAML_DEPTH','$','yaml.maxDepth','YAML nesting exceeds the supported depth');return visit.SKIP;}
      if(isAlias(node)||(isNode(node)&&('anchor'in node&&node.anchor||node.tag)))issue('YAML_DYNAMIC','$','yaml.no-dynamic-content','Aliases, anchors and explicit tags are not supported');
    });
    if(issues.length)return result;
    data=record(document.toJS({maxAliasCount:0}));canonical(data);
  }catch(e){issue('YAML_STRUCTURE','$','yaml.plain-data',e instanceof ServiceError?e.code:'Invalid YAML structure');return result;}
  let trusted:ReturnType<typeof loadPublisherBase>;
  try{trusted=loadPublisherBase();}catch(e){issue('UNTRUSTED_BASE','extends','base.publisher-anchor',e instanceof ServiceError?e.message:'Publisher Base unavailable');return result;}
  const {base,pin}=trusted,provider=atPath(data,'config.implementation.provider');
  const allFields=new Map(base.fields.map(f=>[f.path,f]));
  const prefixes=new Set(base.fields.flatMap(f=>f.path.split('.').map((_x,i,a)=>a.slice(0,i).join('.')).filter(Boolean)));
  function unknown(v:unknown,path:string){
    if(allFields.has(path)||path==='extensions'||path==='presentation')return;
    if(path && !prefixes.has(path)){issue('UNKNOWN_FIELD',path,'schema.closed','Field is not declared by the Base');return;}
    if(!plain(v)){issue('INVALID_TYPE',path||'$','schema.object','Expected a mapping');return;}
    for(const [k,x]of Object.entries(v))unknown(x,path?path+'.'+k:k);
  }
  unknown(data,'');
  function valid(value:unknown,field:FieldRule):boolean {
    const rules=field.rules;
    if(value===undefined){issue('REQUIRED_FIELD',field.path,'stage.'+field.stage+'.required','Required configuration is missing');return false;}
    let ok=false;
    switch(field.type){
      case 'string':ok=typeof value==='string'&&value.trim().length>0&&value.length<=512&&!/[\u0000-\u001f]/.test(value)&&!placeholder.test(value.trim());break;
      case 'slug':ok=typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)&&!placeholder.test(value);break;
      case 'version':ok=typeof value==='string'&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value);break;
      case 'digest':ok=typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);break;
      case 'bindingRef':ok=typeof value==='string'&&bindingPattern.test(value)&&!value.split('/').includes('..');break;
      case 'credentialRef':ok=typeof value==='string'&&credentialPattern.test(value)&&!value.split('/').includes('..');break;
      case 'repositoryPath':ok=relativePath(value);break;
      case 'httpsOrigin':try{const url=new URL(String(value));ok=typeof value==='string'&&url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash&&value.replace(/\/$/,'')===url.origin;}catch{}break;
      case 'enum':ok=Array.isArray(rules.values)&&rules.values.includes(value);break;
      case 'integer':ok=Number.isSafeInteger(value)&&Number(value)>=Number(rules.minimum)&&Number(value)<=Number(rules.maximum);break;
      case 'stringList':case 'bindingList':case 'pathList':ok=Array.isArray(value)&&value.length>=Number(rules.minItems??1)&&value.length<=64&&new Set(value).size===value.length&&value.every(x=>typeof x==='string'&&x.length>0&&x.length<=512&&!placeholder.test(x)&&(!Array.isArray(rules.values)||rules.values.includes(x))&&(field.type!=='bindingList'||bindingPattern.test(x))&&(field.type!=='pathList'||relativePath(x)))&&(!Array.isArray(rules.contains)||rules.contains.every(x=>value.includes(x)));break;
    }
    if(rules.fixed!==undefined&&value!==rules.fixed)ok=false;
    if(!ok)issue('INVALID_VALUE',field.path,'field.'+field.policy.toLowerCase(),'Value does not satisfy the declared type, reference or constraint');
    return ok;
  }
  const fieldSources:Record<string,string>={};
  for(const field of base.fields){
    const value=atPath(data,field.path);
    if(typeof provider==='string'&&!field.providers.includes(provider)){if(value!==undefined)issue('INACTIVE_PROVIDER_FIELD',field.path,'provider.exclusive','Configuration belongs to the unselected provider');continue;}
    valid(value,field);fieldSources[field.path]=field.policy==='LOCKED'?'base':'project';
  }
  if(data.projectId!==projectId)issue('PROJECT_SCOPE','projectId','scope.exact','YAML project must match the authenticated request');
  if(!plain(data.extends)||canonical(data.extends)!==canonical(pin))issue('BASE_PIN','extends','base.exact-single-pin','Select the exact installed Base id, version, schema and digest');
  const channel=atPath(data,'config.publication.channel');
  if((provider==='github'&&channel!=='github-release')||(provider==='gitlab'&&channel!=='gitlab-release'))issue('PROVIDER_CHANNEL','config.publication.channel','provider.supported-pair','This version requires the matching GitHub/Actions or GitLab/CI channel');
  for(const owner of ['ontology','harness'])if(atPath(data,'assets.'+owner+'.visibility')==='private'&&atPath(data,'assets.'+owner+'.projectId')!==projectId)issue('ASSET_SCOPE','assets.'+owner+'.projectId','scope.owner-asset','Private assets must belong to the same project');

  const nodes:EffectiveNode[]=base.stages.map(s=>({id:s.id,source:'base',stage:s.id,required:true,dependsOn:[...s.requires],checks:[...s.checks,...(Array.isArray(atPath(data,'config.'+s.id+'.requiredChecks'))?atPath(data,'config.'+s.id+'.requiredChecks') as string[]:[])]}));
  const extensions=data.extensions??[];
  const byId=new Map<string,Record<string,unknown>>();
  if(!Array.isArray(extensions)||extensions.length>64)issue('EXTENSION_LIMIT','extensions','extension.limit','Expected at most 64 extension stages');
  else for(let i=0;i<extensions.length;i++){
    const e=extensions[i],path='extensions.'+i;
    if(!plain(e)){issue('EXTENSION_TYPE',path,'extension.schema','Expected an extension mapping');continue;}
    if(base.extensionRequiredFields.some(k=>!Object.hasOwn(e,k))||Object.keys(e).some(k=>!base.extensionRequiredFields.includes(k)))issue('EXTENSION_FIELDS',path,'extension.closed','Missing or unsupported extension field');
    if(typeof e.id!=='string'||!projectNode.test(e.id)||byId.has(e.id)){issue('EXTENSION_ID',path+'.id','extension.namespace','Use a unique project.<id>');continue;}
    byId.set(e.id,e);
    const slot=base.slots[String(e.slot)],action=base.actions.find(a=>a.id===e.actionRef);
    if(!slot||!slot.types.includes(String(e.type)))issue('EXTENSION_SLOT',path+'.slot','extension.slot-types','The declared slot does not permit this action type');
    if(!action||action.type!==e.type||action.version!==e.actionVersion||valueDigest(action)!==e.actionDigest)issue('ACTION_PIN',path+'.actionRef','action.registered-pin','Action must pin a registered type, version and digest');
    if(!plain(e.parameters)||!action||Object.keys(e.parameters).some(k=>!Object.hasOwn(action.parameterSchema,k))||Object.keys(action?.parameterSchema??{}).some(k=>typeof (e.parameters as Record<string,unknown>)[k]!=='string'||!bindingPattern.test(String((e.parameters as Record<string,unknown>)[k]))))issue('ACTION_PARAMETERS',path+'.parameters','action.typed-parameters','Only the registered typed binding parameters are allowed');
    if(e.scopeRef!=='scope:'+projectId)issue('EXTENSION_SCOPE',path+'.scopeRef','scope.exact','Extension must use the current project scope');
    if(typeof e.evidenceMappingRef!=='string'||!bindingPattern.test(e.evidenceMappingRef)||!Array.isArray(e.requirementRefs)||!e.requirementRefs.length||e.requirementRefs.length>64||new Set(e.requirementRefs).size!==e.requirementRefs.length||e.requirementRefs.some(x=>typeof x!=='string'||!bindingPattern.test(x)))issue('EXTENSION_REQUIREMENTS',path,'extension.requirements-evidence','Exact requirement and evidence bindings are required');
    const budget=atPath(data,'config.'+(['candidate-checks','before-release-decision'].includes(String(e.slot))?'verification':'plan')+'.budget');
    const keys=['timeoutSeconds','maxAttempts','maxConcurrency','maxLoops'];
    if(!plain(e.budget)||!plain(budget)||Object.keys(e.budget).some(k=>!keys.includes(k))||keys.some(k=>!Number.isSafeInteger((e.budget as Record<string,unknown>)[k])||Number((e.budget as Record<string,unknown>)[k])<1||Number((e.budget as Record<string,unknown>)[k])>Number((budget as Record<string,unknown>)[k])))issue('EXTENSION_BUDGET',path+'.budget','budget.bounded','Extension budget must fit the project bounds and later exact instance authority');
    if(!Array.isArray(e.dependsOn)||new Set(e.dependsOn).size!==e.dependsOn.length||e.dependsOn.some(x=>typeof x!=='string'||!projectNode.test(x)))issue('EXTENSION_DEPENDENCY',path+'.dependsOn','graph.same-slot','Only unique project-stage dependencies are allowed');
  }
  const visiting=new Set<string>(),visited=new Set<string>();
  function traverse(id:string):void{
    if(visiting.has(id)){issue('GRAPH_CYCLE','extensions.'+id,'graph.dag','Extension dependencies contain a cycle');return;}
    if(visited.has(id))return;visiting.add(id);
    const e=byId.get(id)!;
    for(const dep of Array.isArray(e.dependsOn)?e.dependsOn:[]){const parent=byId.get(String(dep));if(!parent||parent.slot!==e.slot)issue('CROSS_SLOT_DEPENDENCY','extensions.'+id+'.dependsOn','graph.same-slot','Dependency must reference an existing stage in the same slot');else traverse(String(dep));}
    visiting.delete(id);visited.add(id);
  }
  for(const id of byId.keys())traverse(id);
  for(const [id,e]of byId){const slot=base.slots[String(e.slot)];if(!slot)continue;
    nodes.push({id,source:'project',stage:String(e.slot),required:true,dependsOn:[slot.predecessor,...(Array.isArray(e.dependsOn)?e.dependsOn as string[]:[])].filter((x,i,a)=>a.indexOf(x)===i),checks:Array.isArray(e.requirementRefs)?e.requirementRefs as string[]:[],action:e});
    nodes.find(n=>n.id===slot.successor)!.dependsOn.push(id);
  }
  const presentation=data.presentation??{};
  if(!plain(presentation)||Object.keys(presentation).some(k=>!['label','notes','layout'].includes(k)))issue('PRESENTATION_FIELDS','presentation','presentation.closed','Unsupported presentation field');
  else{
    if(presentation.label!==undefined&&(typeof presentation.label!=='string'||presentation.label.length>128))issue('PRESENTATION_LABEL','presentation.label','presentation.label','Label must be at most 128 characters');
    if(presentation.notes!==undefined&&(typeof presentation.notes!=='string'||presentation.notes.length>8192))issue('PRESENTATION_NOTES','presentation.notes','presentation.notes','Notes must be at most 8192 characters');
    if(presentation.layout!==undefined){if(!plain(presentation.layout))issue('PRESENTATION_LAYOUT','presentation.layout','presentation.layout','Expected positions keyed by node ID');else for(const [id,pos]of Object.entries(presentation.layout))if(!nodes.some(n=>n.id===id)||!plain(pos)||Object.keys(pos).sort().join(',')!=='x,y'||![pos.x,pos.y].every(x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=100000))issue('PRESENTATION_LAYOUT','presentation.layout.'+id,'presentation.positions','Use an existing node and finite bounded x/y coordinates');}
  }
  if(issues.length)return result;
  const semantic=JSON.parse(canonical(data)) as Record<string,unknown>;delete semantic.presentation;
  for(const f of base.fields){const v=atPath(semantic,f.path);if(Array.isArray(v))v.sort();}
  const ex=(semantic.extensions??[]) as Record<string,unknown>[];ex.sort((a,b)=>String(a.id).localeCompare(String(b.id)));for(const e of ex){(e.dependsOn as string[]).sort();(e.requirementRefs as string[]).sort();}semantic.extensions=ex;
  const semanticDigest=valueDigest(semantic);
  result.valid=true;result.presentationDigest=valueDigest(presentation);result.effective={schema:'runtime-effective-lifecycle/v1',projectId,base:pin,semanticDigest,semantic,nodes,fieldSources};return result;
}
