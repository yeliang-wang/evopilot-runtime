import {parseDocument,visit,isAlias,isNode} from 'yaml';
import type {Base,Field,GraphNode} from './types';

export const stageLabels:Record<string,string>={scope:'范围定义',plan:'方案设计',implementation:'实现与评审',candidate:'候选构建',verification:'验收验证','release-decision':'发布决定',publication:'版本发布',closure:'交付闭环'};
export function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('需要一个 YAML 映射。');return v as Record<string,unknown>;}
export function document(source:string){
 if(new TextEncoder().encode(source).length>262144)throw Error('YAML 超过 256 KiB。');
 const doc=parseDocument(source,{version:'1.2',strict:true,uniqueKeys:true,stringKeys:true,keepSourceTokens:true,prettyErrors:false});
 if(doc.errors.length||doc.warnings.length)throw Error('YAML 语法错误：'+[...doc.errors,...doc.warnings].map(e=>e.code).join('、'));
 let invalid=false;visit(doc,(_key,node,path)=>{if(path.length>32){invalid=true;return visit.SKIP;}if(isAlias(node)||isNode(node)&&('anchor'in node&&node.anchor||node.tag))invalid=true;});
 if(invalid)throw Error('不支持 YAML 别名、锚点、标签或过深嵌套。');object(doc.toJS({maxAliasCount:0}));return doc;
}
export function data(source:string){return object(document(source).toJS({maxAliasCount:0}));}
export function at(value:unknown,path:string):unknown {let next=value;for(const key of path.split('.')){if(!next||typeof next!=='object'||Array.isArray(next)||!Object.hasOwn(next,key))return undefined;next=(next as Record<string,unknown>)[key];}return next;}
function safePath(path:string){const keys=path.split('.');if(keys.some(k=>!k||['__proto__','constructor','prototype'].includes(k)))throw Error('不支持的字段路径。');return keys;}
export function changeField(source:string,field:Field,value:unknown):string{
 if(field.policy==='LOCKED')throw Error('该字段由 Base 锁定，只能由 Runtime 发布者修改。');
 const doc=document(source);doc.setIn(safePath(field.path),value);return doc.toString({lineWidth:0});
}
export function moveNode(source:string,nodes:GraphNode[],id:string,x:number,y:number):string{
 if(!nodes.some(n=>n.id===id)||![x,y].every(v=>Number.isFinite(v)&&Math.abs(v)<=100000))throw Error('节点或位置无效。');
 const doc=document(source);doc.setIn(['presentation','layout',id],{x,y});return doc.toString({lineWidth:0});
}
/** Resolve display cells only. Saved YAML positions are preferences, not an
 * instruction to drop a node when another extension occupies the same cell.
 * Reserve explicit positions first; put collisions in the next free row of
 * the same column, searching back below the preference at the upper bound.
 * Stable ordering makes this projection reproducible. */
export function graphLayout(nodes:GraphNode[],layout:Record<string,{x:number;y:number}>={}){
 if(nodes.length>72||new Set(nodes.map(n=>n.id)).size!==nodes.length||nodes.some(n=>! /^[a-z][a-z0-9.-]{0,100}$/.test(n.id)))throw Error('图形节点不符合支持范围。');
 const ranks=new Map<string,number>(),visiting=new Set<string>(),byId=new Map(nodes.map(n=>[n.id,n]));
 function rank(id:string):number{if(ranks.has(id))return ranks.get(id)!;if(visiting.has(id))throw Error('依赖图中存在循环。');const n=byId.get(id);if(!n)throw Error('缺少依赖节点。');visiting.add(id);const value=Math.max(0,...n.dependsOn.map(p=>rank(p)+1));ranks.set(id,value);visiting.delete(id);return value;}
 nodes.forEach(n=>rank(n.id));
 const ordered=[...nodes].sort((a,b)=>ranks.get(a.id)!-ranks.get(b.id)!||a.id.localeCompare(b.id)),rows=new Map<number,number>(),occupied=new Set<string>();
 const positions:Record<string,{x:number;y:number;row:number;col:number}>={};
 const place=(id:string,p:{x:number;y:number})=>{
  if(![p.x,p.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=100000))throw Error('节点位置无效。');
  const col=Math.round(p.x/200),preferredRow=Math.round(p.y/90),minimumRow=Math.ceil(-100000/90),maximumRow=Math.floor(100000/90);let row=preferredRow;
  while(row<=maximumRow&&occupied.has(row+','+col))row++;
  if(row>maximumRow){row=preferredRow-1;while(row>=minimumRow&&occupied.has(row+','+col))row--;}
  if(row<minimumRow)throw Error('没有界限内可用的节点位置。');
  occupied.add(row+','+col);positions[id]={x:p.x,y:row===preferredRow?p.y:row*90,row,col};
 };
 for(const n of ordered)if(layout[n.id])place(n.id,layout[n.id]);
 for(const n of ordered)if(!layout[n.id]){const col=ranks.get(n.id)!,row=rows.get(col)??0;rows.set(col,row+1);place(n.id,{x:col*200,y:row*90});}
 return positions;
}
export function extensions(source:string):Record<string,unknown>[]{const v=data(source).extensions??[];if(!Array.isArray(v)||v.some(e=>!e||typeof e!=='object'||Array.isArray(e)))throw Error('扩展必须是映射列表。');return v as Record<string,unknown>[];}
export function changeExtension(source:string,id:string,value:Record<string,unknown>):string{
 const doc=document(source),entries=extensions(source),index=entries.findIndex(e=>e.id===id);if(index<0||value.id!==id)throw Error('扩展标识不可通过属性编辑更改。');
 doc.setIn(['extensions',index],value);return doc.toString({lineWidth:0});
}
export function addExtension(source:string,base:Base,id:string,slot:string,actionId:string):string{
 if(!/^project\.[a-z][a-z0-9-]{0,62}$/.test(id))throw Error('扩展标识须为 project.<名称>。');const entries=extensions(source);if(entries.length>=64||entries.some(e=>e.id===id))throw Error('扩展已存在或超过 64 项。');
 const action=base.actions.find(a=>a.id===actionId),selected=base.slots[slot];if(!action||!selected||!selected.types.includes(action.type))throw Error('该槽位不支持所选动作。');
 const doc=document(source),v=data(source),stage=['candidate-checks','before-release-decision'].includes(slot)?'verification':'plan';
 const entry={id,slot,type:action.type,actionRef:action.id,actionVersion:action.version,actionDigest:action.digest,parameters:Object.fromEntries(Object.keys(action.parameterSchema).map(k=>[k,''])),requirementRefs:[],evidenceMappingRef:'',scopeRef:'scope:'+String(v.projectId),budget:at(v,'config.'+stage+'.budget')??{},dependsOn:[]};
 if(!doc.has('extensions'))doc.set('extensions',doc.createNode([]));doc.addIn(['extensions'],doc.createNode(entry));return doc.toString({lineWidth:0});
}
/** Presentation-only draft projection. The service compiler remains the authority.
 * Incomplete extension parameters must stay selectable so they can be completed. */
export function draftNodes(base:Base,value:Record<string,unknown>|null):GraphNode[]{
 const nodes:GraphNode[]=base.stages.map(s=>({id:s.id,source:'base',stage:s.id,dependsOn:[...s.requires],checks:[...s.checks]}));
 if(!value||!Array.isArray(value.extensions)||value.extensions.length>64)return nodes;
 for(const v of value.extensions){
  if(!v||typeof v!=='object'||Array.isArray(v))continue;const e=v as Record<string,unknown>,slot=typeof e.slot==='string'?base.slots[e.slot]:undefined;
  if(typeof e.id!=='string'||!/^project\.[a-z][a-z0-9-]{0,62}$/.test(e.id)||!slot||nodes.some(n=>n.id===e.id))continue;
  const deps=Array.isArray(e.dependsOn)?e.dependsOn.filter((id):id is string=>typeof id==='string'):[];
  nodes.push({id:e.id,source:'project',stage:String(e.slot),dependsOn:[slot.predecessor,...deps],checks:[]});
  nodes.find(n=>n.id===slot.successor)?.dependsOn.push(e.id);
 }
 return nodes;
}
export function removeExtension(source:string,id:string):string{
 const list=extensions(source),index=list.findIndex(e=>e.id===id);if(index<0)throw Error('只能删除项目扩展，Base 阶段不可删除。');
 if(list.some(e=>Array.isArray(e.dependsOn)&&e.dependsOn.includes(id)))throw Error('请先移除其他扩展对该节点的依赖。');
 const doc=document(source);doc.deleteIn(['extensions',index]);if(doc.hasIn(['presentation','layout',id]))doc.deleteIn(['presentation','layout',id]);return doc.toString({lineWidth:0});
}
export function connectExtension(source:string,from:string,to:string,connected:boolean):string{
 const list=extensions(source),a=list.find(e=>e.id===from),b=list.find(e=>e.id===to);if(!a||!b||a.slot!==b.slot||from===to)throw Error('仅支持同一槽位内的项目节点连线，Base 依赖不可更改。');
 const deps=new Set(Array.isArray(b.dependsOn)?b.dependsOn as string[]:[]);connected?deps.add(from):deps.delete(from);
 const byId=new Map(list.map(e=>[String(e.id),e===b?[...deps]:Array.isArray(e.dependsOn)?e.dependsOn as string[]:[]]));
 const visiting=new Set<string>(),visited=new Set<string>();function check(id:string){if(visiting.has(id))throw Error('该连线会产生循环。');if(visited.has(id))return;visiting.add(id);for(const parent of byId.get(id)??[])check(parent);visiting.delete(id);visited.add(id);}for(const id of byId.keys())check(id);
 const doc=document(source);doc.setIn(['extensions',list.indexOf(b),'dependsOn'],[...deps]);return doc.toString({lineWidth:0});
}
export function displayValue(value:unknown):string{return value===undefined?'':typeof value==='string'?value:JSON.stringify(value);}
export function fieldValue(text:string,type:string):unknown {if(['integer'].includes(type)){if(!/^-?\d+$/.test(text))throw Error('请输入整数。');return Number(text);}if(['stringList','bindingList','pathList'].includes(type)){const value=JSON.parse(text);if(!Array.isArray(value)||value.some(v=>typeof v!=='string'))throw Error('请输入字符串数组。');return value;}return text;}
export function diffLines(before:string,after:string):string{
 if(before===after)return '没有变更';const a=before.split('\n'),b=after.split('\n');let first=0,last=0;
 while(first<a.length&&first<b.length&&a[first]===b[first])first++;
 while(last<a.length-first&&last<b.length-first&&a[a.length-1-last]===b[b.length-1-last])last++;
 return['@@ 第 '+(first+1)+' 行起 @@',...a.slice(first,a.length-last).map(s=>'- '+s),...b.slice(first,b.length-last).map(s=>'+ '+s)].join('\n');
}
