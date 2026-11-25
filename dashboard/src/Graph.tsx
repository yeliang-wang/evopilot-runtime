import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {render} from '../vendor/seecode/lib/render/graph/graph.mjs';
import {stageLabels,graphLayout,feedbackStageLabels,feedbackStages,feedbackStatusLabels,feedbackReturnLabel} from './model';
import type {FeedbackCase,FeedbackStage} from './model';
import type {GraphNode,Stage} from './types';

interface Props {nodes:GraphNode[];layout?:Record<string,{x:number;y:number}>;selected?:string;states?:Record<string,Stage>;onSelect?:(id:string)=>void;onMove?:(id:string,x:number,y:number)=>void;}
export function Graph({nodes,layout={},selected,states,onSelect,onMove}:Props){
 const ref=useRef<SVGSVGElement>(null),drag=useRef<{id:string;x:number;y:number}|null>(null),[failure,setFailure]=useState(''),[zoom,setZoom]=useState(1);
 const result=useMemo(()=>{try{
  const positions=graphLayout(nodes,layout);
  if(!nodes.length)return null;
  const items=nodes.map(n=>{const p=positions[n.id];return{id:n.id,label:stageLabels[n.id]??n.id.replace(/^project\./,''),row:p.row,col:p.col,shape:'box',kind:n.source==='base'?'backend':'focal',tag:n.source==='base'?'BASE · LOCKED':'PROJECT',sub:states?.[n.id]?.status??n.stage};});
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

const feedbackColors = {
 visited: {fill:'#e7f6ed',stroke:'#287649',text:'#1b5937'},
 upcoming: {fill:'#f1f4f6',stroke:'#a6b3bf',text:'#526373'},
 current: {fill:'#eeedff',stroke:'#4038db',text:'#2b249e'},
 waiting: {fill:'#fff4d7',stroke:'#9b680d',text:'#784c00'},
 failed: {fill:'#fdebec',stroke:'#b53c3c',text:'#9b2d2d'},
};
const nodeCenter = (stage: FeedbackStage) => 75 + feedbackStages.indexOf(stage)*143;

export function FeedbackMonitorGraph({entry}:{entry:FeedbackCase}) {
 const title = useId(), description = useId(), arrow = useId();
 const visited = new Set(entry.visited);
 const forward = new Set<string>();
 const returns = new Map<string,{from:FeedbackStage;to:FeedbackStage;reason:string}>();
 for (let index=0; index<entry.timeline.length; index++) {
  const event = entry.timeline[index];
  if (event.returnFrom) {
   returns.set(event.returnFrom+'>'+event.stage,{from:event.returnFrom,to:event.stage,reason:event.reason});
  } else if (index > 0) {
   forward.add(entry.timeline[index-1].stage+'>'+event.stage);
  }
 }
 const nodeTop = 29 + returns.size*25;
 const nodeMiddle = nodeTop + 35;
 return <section className="graph-card" aria-labelledby={title}>
  <div className="graph-toolbar"><h2 id={title} style={{margin:0}}>执行流程</h2></div>
  <div className="table-scroll">
   <svg className="sc-svg" role="img" aria-labelledby={title} aria-describedby={description}
    width="100%" viewBox={`0 0 1008 ${nodeTop+91}`} style={{minWidth:740}}>
    <desc id={description}>{'当前阶段 '+feedbackStageLabels[entry.stage]+'，'+feedbackStatusLabels[entry.status]+
     '。已到达 '+entry.visited.map(stage=>feedbackStageLabels[stage]).join('、')+
     '。'+[...returns.values()].map(({from,to,reason})=>feedbackStageLabels[from]+' → '+feedbackStageLabels[to]+'，'+reason).join('。')}</desc>
    <defs><marker id={arrow} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
     <path d="M0 0 L7 3.5 L0 7 Z" fill="#9b680d"/>
    </marker></defs>
    {[...returns.values()].map(({from,to,reason},index)=>{
     const start = nodeCenter(from) + (from===to ? 27 : 0);
     const end = nodeCenter(to) - (from===to ? 27 : 0);
     const lane = 26 + index*25;
     return <g key={from+'>'+to} data-return-from={from} data-return-to={to}>
      <title>{reason}</title>
      <path d={`M${start} ${nodeTop-2} V${lane} H${end} V${nodeTop-3}`} fill="none"
       stroke="#9b680d" strokeWidth="2" strokeDasharray="6 4" markerEnd={`url(#${arrow})`}/>
      <text x={(start+end)/2} y={lane-7} textAnchor="middle" fill="#784c00" fontSize="15" fontWeight="650">
       {feedbackReturnLabel(from,to)}
      </text>
     </g>;
    })}
    {feedbackStages.slice(1).map((stage,index)=>{
     const from = feedbackStages[index];
     const walked = forward.has(from+'>'+stage);
     const color = walked ? feedbackColors.visited.stroke : feedbackColors.upcoming.stroke;
     const start = nodeCenter(from)+60, end = nodeCenter(stage)-60;
     return <g key={stage} data-from={from} data-to={stage} data-visited={walked}>
      <line x1={start} x2={end-7} y1={nodeMiddle} y2={nodeMiddle} stroke={color} strokeWidth="2"/>
      <path d={`M${end-7} ${nodeMiddle-5} L${end} ${nodeMiddle} L${end-7} ${nodeMiddle+5} Z`} fill={color}/>
     </g>;
    })}
    {feedbackStages.map(stage=>{
     const current = entry.stage===stage;
     let variant = visited.has(stage) ? feedbackColors.visited : feedbackColors.upcoming;
     if (current && entry.status!=='COMPLETE') {
      variant = entry.status==='FAILED' ? feedbackColors.failed :
       entry.status==='WAITING'||entry.status==='UNKNOWN' ? feedbackColors.waiting : feedbackColors.current;
     }
     const x = nodeCenter(stage);
     return <g key={stage} data-feedback-stage={stage} data-current={current} data-visited={visited.has(stage)}
      data-status={current ? entry.status : undefined}>
      <rect x={x-58} y={nodeTop} width="116" height="70" rx="9" fill={variant.fill} stroke={variant.stroke} strokeWidth={current?3:1.5}/>
      <text x={x} y={nodeTop+28} textAnchor="middle" fill={variant.text} fontSize="17" fontWeight="650">{feedbackStageLabels[stage]}</text>
      <text x={x} y={nodeTop+50} textAnchor="middle" fill={variant.text} fontSize="13">
       {current ? '当前 · '+feedbackStatusLabels[entry.status] : visited.has(stage) ? '已到达' : '待到达'}
      </text>
     </g>;
    })}
   </svg>
  </div>
 </section>;
}
