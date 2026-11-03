import {useEffect,useRef,useState} from 'react';
import {ApiError,monitor} from './api';
import {Graph} from './Graph';
import {stageLabels} from './model';
import type {MonitorPage,Session} from './types';

const labels:Record<string,string>={PENDING:'待进行',RUNNING:'进行中',UNKNOWN:'结果待核对',FAILED:'未通过',PASSED:'已通过'};
export function Monitor({session,onAuthLost}:{session:Session;onAuthLost:()=>void}){
 const [page,setPage]=useState<MonitorPage|null>(null),[selected,setSelected]=useState(''),[node,setNode]=useState(''),[message,setMessage]=useState('正在连接实时事件…'),[error,setError]=useState(''),[loading,setLoading]=useState(true),[pages,setPages]=useState(1),[connected,setConnected]=useState(false);
 const revision=useRef(0),sequence=useRef(0),pageCount=useRef(pages);pageCount.current=pages;
 useEffect(()=>{
  let closed=false,source:EventSource|undefined,timer:ReturnType<typeof setTimeout>|undefined,refreshing=false,queued=false,cursor='';sequence.current=0;revision.current=0;setPage(null);setSelected('');setNode('');setLoading(true);
  async function refresh(){if(closed)return;if(refreshing){queued=true;return;}refreshing=true;
   try{let current=await monitor(),all=[...current.instances];for(let n=1;n<pageCount.current&&current.nextAfter;n++){current=await monitor(current.nextAfter,current.revision);all.push(...current.instances);}if(!closed){revision.current=current.revision;setPage({...current,instances:all});setError('');setLoading(false);setSelected(old=>all.some(i=>i.id===old)?old:all[0]?.id??'');}}
   catch(e){if(!closed){setLoading(false);setError(e instanceof ApiError&&e.code==='TRANSPORT_UNKNOWN'?'Runtime 服务暂时无法连接。':e instanceof Error?e.message:String(e));setConnected(false);if(e instanceof ApiError&&e.status===401){closed=true;source?.close();onAuthLost();}}}
   finally{refreshing=false;if(queued&&!closed){queued=false;void refresh();}}
  }
  function reconnect(){if(closed)return;source?.close();source=new EventSource('/api/v1/dashboard/events'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
   source.onopen=()=>{if(!closed){setConnected(true);setMessage('实时连接已建立');}};
   const event=(value:MessageEvent)=>{if(closed)return;try{const data=JSON.parse(String(value.data)) as {cursor:string;events:{seq:number;revision:number}[]};if(typeof data.cursor!=='string'||!Array.isArray(data.events))throw Error('事件格式无效');
    let changed=false,gap=false,observed=revision.current;for(const e of data.events){if(!Number.isSafeInteger(e.seq)||!Number.isSafeInteger(e.revision))throw Error('事件序号无效');if(e.seq<=sequence.current)continue;sequence.current=e.seq;if(e.revision>observed){if(e.revision>observed+1)gap=true;observed=e.revision;changed=true;}}
    cursor=data.cursor;if(changed||!revision.current)void refresh();if(gap)setMessage('事件存在间隔，已请求完整快照核对。');else setMessage('实时连接已建立');
   }catch{setMessage('事件无法连续读取，正在重建快照。');cursor='';sequence.current=0;void refresh();}};
   for(const name of ['snapshot','events','heartbeat'])source.addEventListener(name,event as EventListener);
   source.addEventListener('error',e=>{if(closed)return;source?.close();setConnected(false);setMessage('实时连接中断，保留最后已核对状态。');
    if(e instanceof MessageEvent){try{const code=(JSON.parse(String(e.data)) as {code:string}).code;if(['UNAUTHENTICATED','FORBIDDEN','BROWSER_SESSION_REVOKED','BROWSER_SESSION_EXPIRED'].includes(code)){closed=true;onAuthLost();return;}}catch{/* A malformed stream requires a fresh snapshot. */}}
    cursor='';sequence.current=0;void refresh();timer=setTimeout(reconnect,3000);
   });
  }
  void refresh();reconnect();const poll=setInterval(()=>void refresh(),10000);
  return()=>{closed=true;source?.close();if(timer)clearTimeout(timer);clearInterval(poll);};
 },[session.serviceId,session.projectId,session.principalId,session.csrf,pages]);
 const instance=page?.instances.find(i=>i.id===selected),stage=instance?.stages[node];
 return <><div className="page-heading"><div><p className="eyebrow">LIVE LIFECYCLE</p><h1>生命周期监控</h1><p>跟踪实际实例与阶段回执。此页面只读。</p></div><span className={'connection '+(connected?'online':'offline')}>{connected?'● 实时连接':'○ 连接中断'}</span></div>
  <div className="monitor-strip" role="status"><span>{message}</span><span>{page?'最近核对 '+new Date(page.observedAt).toLocaleTimeString():''}</span></div>
  {error?<div role="alert" className="notice error">{error} 当前显示结果不代表持续在线。</div>:null}
  {loading?<div className="panel" role="status">正在读取生命周期实例…</div>:!page?.instances.length?<section className="panel empty"><h2>暂无生命周期实例</h2><p>项目定义启用后，仍需通过 Expert 显式绑定目标并建立实例。监控不会启动任务。</p></section>:<>
   <section className="panel instance-select"><label htmlFor="instance">生命周期实例</label><select id="instance" value={selected} onChange={e=>{setSelected(e.target.value);setNode('');}}>{page.instances.map(i=><option key={i.id} value={i.id}>{i.id}</option>)}</select>{page.nextAfter?<button type="button" onClick={()=>setPages(n=>n+1)}>加载更多实例</button>:null}<span className="muted">已读取 {page.instances.length} 个实例</span></section>
   {instance?<><div className="instance-pins"><div><span>固定定义修订</span><code title={instance.definitionRevisionId}>{instance.definitionRevisionId}</code></div><div><span>Goal / Target / Loop</span><code>{instance.goalRef} / {instance.targetRef} / {instance.loopRef}</code></div><div><span>Base 版本</span><strong>{instance.base.id} @{instance.base.version}</strong></div></div>
    <Graph nodes={instance.graph} states={instance.stages} selected={node} onSelect={setNode}/>
    <section className="panel"><div className="section-heading"><h2>阶段状态</h2><span className="muted">未知结果不会计为通过</span></div><div className="table-scroll"><table><thead><tr><th>阶段</th><th>状态</th><th>尝试</th><th>请求 / 回执</th><th>请求时间</th></tr></thead><tbody>{instance.graph.map(n=>{const s=instance.stages[n.id];return <tr key={n.id} data-selected={node===n.id}><td><button type="button" className="text-button" onClick={()=>setNode(n.id)}>{stageLabels[n.id]??n.id}</button><small>{n.source==='base'?'Base':'项目扩展'}</small></td><td><span className={'status '+s.status}>{labels[s.status]}</span></td><td>{s.attempts}</td><td><code>{s.requestId??'尚无请求'}</code><small>{s.receiptRef??'尚无回执'}</small></td><td>{s.requestedAt?new Date(s.requestedAt).toLocaleString():'—'}</td></tr>;})}</tbody></table></div></section>
    {stage?<section className="panel"><h2>{stageLabels[node]??node} · 观测详情</h2><dl className="details"><dt>状态</dt><dd>{labels[stage.status]}</dd><dt>原请求</dt><dd>{stage.requestId??'尚无请求'}</dd><dt>回执引用</dt><dd>{stage.receiptRef??'尚无回执'}</dd><dt>结果摘要</dt><dd>{stage.outcomeDigest??'尚无结果'}</dd><dt>有效期</dt><dd>{stage.expiresAt??'尚未执行'}</dd></dl></section>:null}
   </>:null}
  </>}
 </>;
}
