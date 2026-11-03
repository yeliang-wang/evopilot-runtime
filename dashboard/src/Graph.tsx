import {useEffect,useMemo,useRef,useState} from 'react';
import {render} from '../vendor/seecode/lib/render/graph/graph.mjs';
import {stageLabels} from './model';
import type {GraphNode,Stage} from './types';

interface Props {nodes:GraphNode[];layout?:Record<string,{x:number;y:number}>;selected?:string;states?:Record<string,Stage>;onSelect?:(id:string)=>void;onMove?:(id:string,x:number,y:number)=>void;}
export function Graph({nodes,layout={},selected,states,onSelect,onMove}:Props){
 const ref=useRef<SVGSVGElement>(null),drag=useRef<{id:string;x:number;y:number}|null>(null),[failure,setFailure]=useState(''),[zoom,setZoom]=useState(1);
 const result=useMemo(()=>{try{
  if(nodes.length>72||new Set(nodes.map(n=>n.id)).size!==nodes.length||nodes.some(n=>! /^[a-z][a-z0-9.-]{0,100}$/.test(n.id)))throw Error('图形节点不符合支持范围。');
  if(!nodes.length)return null;
  const ranks=new Map<string,number>(),visiting=new Set<string>(),byId=new Map(nodes.map(n=>[n.id,n]));
  function rank(id:string):number{if(ranks.has(id))return ranks.get(id)!;if(visiting.has(id))throw Error('依赖图中存在循环。');const n=byId.get(id);if(!n)throw Error('缺少依赖节点。');visiting.add(id);const value=Math.max(0,...n.dependsOn.map(p=>rank(p)+1));ranks.set(id,value);visiting.delete(id);return value;}
  nodes.forEach(n=>rank(n.id));const used=new Map<number,number>(),positions:Record<string,{x:number;y:number}>={};
  const items=nodes.map(n=>{const col=ranks.get(n.id)!,row=used.get(col)??0;used.set(col,row+1);const p=layout[n.id]??{x:col*200,y:row*90};if(![p.x,p.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=100000))throw Error('节点位置无效。');positions[n.id]=p;return{id:n.id,label:stageLabels[n.id]??n.id.replace(/^project\./,''),row:Math.round(p.y/90),col:Math.round(p.x/200),shape:'box',kind:n.source==='base'?'backend':'focal',tag:n.source==='base'?'BASE · LOCKED':'PROJECT',sub:states?.[n.id]?.status??n.stage};});
  const drawn=render({type:'flowchart',dir:'LR',budget:'off',legend:false,nodes:items,edges:nodes.flatMap(n=>n.dependsOn.map(p=>[p,n.id]))});
  if(!drawn.body||!drawn.viewBox||drawn.problems.some(p=>p.code.startsWith('E_')))throw Error(drawn.problems.map(p=>p.msg).join('；')||'图形渲染未返回结果。');
  return{...drawn,positions};
 }catch(error){return{error:error instanceof Error?error.message:'图形渲染失败。'};}},[nodes,layout,states]);
 useEffect(()=>{
  const svg=ref.current;if(!svg)return;const focused=document.activeElement?.getAttribute('data-sc-node');svg.replaceChildren();setFailure('');if(!result)return;if('error'in result){setFailure(result.error??'图形渲染失败。');return;}
  try{
   const parsed=new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">'+result.body+'</svg>','image/svg+xml');if(parsed.querySelector('parsererror'))throw Error('图形内容无法解析。');
   const allowed=new Set(['svg','g','rect','path','text','tspan','line','polyline','polygon','circle','ellipse','title','defs','marker']);
   for(const e of parsed.querySelectorAll('*')){
    if(!allowed.has(e.localName))throw Error('图形包含不支持的元素。');
    for(const a of [...e.attributes])if(a.name==='style')e.removeAttribute('style');else if(/^on/i.test(a.name)||/href/i.test(a.name)||/url\(/i.test(a.value))throw Error('图形包含不支持的资源引用。');
   }
   svg.setAttribute('viewBox',result.viewBox!.join(' '));svg.setAttribute('width',String(Math.max(640,result.viewBox![2])*zoom));svg.setAttribute('height',String(Math.max(190,result.viewBox![3])*zoom));
   svg.replaceChildren(...[...parsed.documentElement.childNodes].map(n=>document.importNode(n,true)));
   for(const e of svg.querySelectorAll('[data-sc-node]')){const id=e.getAttribute('data-sc-node')!,node=nodes.find(n=>n.id===id)!;e.setAttribute('tabindex','0');e.setAttribute('role','button');e.setAttribute('aria-label',(stageLabels[id]??id)+' · '+(node.source==='base'?'Base 阶段':'项目扩展')+(states?.[id]?' · '+states[id].status:''));e.setAttribute('aria-pressed',String(id===selected));if(states?.[id])e.setAttribute('data-status',states[id].status);}
   if(focused)for(const e of svg.querySelectorAll<SVGGraphicsElement>('[data-sc-node]'))if(e.getAttribute('data-sc-node')===focused)e.focus();
  }catch(error){setFailure(error instanceof Error?error.message:'图形渲染失败。');}
 },[result,selected,zoom,nodes,states]);
 function idOf(target:EventTarget|null){return target instanceof Element?target.closest('[data-sc-node]')?.getAttribute('data-sc-node')??null:null;}
 return <section aria-label="生命周期流程图" className="graph-card">
  <div className="graph-toolbar"><span className="eyebrow">SEECODE / FLOW</span><span>实线依赖 · 全部必需</span><div className="zoom"><button type="button" aria-label="缩小流程图" onClick={()=>setZoom(z=>Math.max(.5,z-.25))}>−</button><output aria-label="流程图缩放">{Math.round(zoom*100)}%</output><button type="button" aria-label="放大流程图" onClick={()=>setZoom(z=>Math.min(2,z+.25))}>+</button></div></div>
  {failure?<div role="alert" className="notice error">图形暂不可用：{failure}。源码与已保存内容保持不变。<ul>{nodes.map(n=><li key={n.id}><button type="button" onClick={()=>onSelect?.(n.id)}>{stageLabels[n.id]??n.id}</button></li>)}</ul></div>:null}
  {!nodes.length?<p className="empty">暂无可呈现的生命周期。请先通过 Expert 完成项目定义。</p>:<div className="graph-scroll" hidden={!!failure}>
   <svg ref={ref} className="sc-svg" aria-label="SeeCode 生命周期依赖图" onClick={e=>{const id=idOf(e.target);if(id)onSelect?.(id);}}
    onPointerDown={e=>{const id=idOf(e.target);if(id&&onMove){drag.current={id,x:e.clientX,y:e.clientY};e.currentTarget.setPointerCapture(e.pointerId);}}}
    onPointerUp={e=>{const d=drag.current;drag.current=null;if(!d||!onMove||!result||'error'in result)return;const dx=e.clientX-d.x,dy=e.clientY-d.y;onSelect?.(d.id);if(Math.abs(dx)+Math.abs(dy)<12)return;const p=result.positions[d.id];onMove(d.id,p.x+Math.round(dx/50)*200,p.y+Math.round(dy/50)*90);}}
    onPointerCancel={()=>{drag.current=null;}}
    onKeyDown={e=>{const id=idOf(e.target);if(!id)return;if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect?.(id);}if(onMove&&['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)&&result&&!('error'in result)){e.preventDefault();const p=result.positions[id];onMove(id,p.x+(e.key==='ArrowLeft'?-200:e.key==='ArrowRight'?200:0),p.y+(e.key==='ArrowUp'?-90:e.key==='ArrowDown'?90:0));}}}/>
  </div>}
  <p className="graph-hint">{onMove?'点击节点查看配置；拖动或使用方向键调整布局。Base 流程关系由发布者锁定。':'实例固定其启动时的生命周期版本。此视图只读。'}</p>
 </section>;
}
