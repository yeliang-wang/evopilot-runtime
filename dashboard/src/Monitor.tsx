import {useEffect,useRef,useState} from 'react';
import {ApiError,feedbackMonitor,monitor} from './api';
import {FeedbackMonitorGraph,Graph} from './Graph';
import {feedbackStageLabels,feedbackStatusLabels,stageLabels,type FeedbackCase,type FeedbackMonitorPage} from './model';
import type {MonitorPage,Session} from './types';

const labels:Record<string,string>={PENDING:'待进行',RUNNING:'进行中',UNKNOWN:'结果待核对',FAILED:'未通过',PASSED:'已通过'};
interface ReplayGap{code:'CURSOR_EXPIRED';afterSequence:number;afterRevision:number;resumeSequence:number;resumeRevision:number;windowEvents:number;}
interface MonitorEvent{projectId:string;cursor:string;events:{seq:number;revision:number}[];watermark:{sequence:number;revision:number};gap:ReplayGap|null;}
const counter=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;

const reasonLabels: Record<string,string> = {
 FEEDBACK_RECEIVED:'收到反馈', ISSUE_LINKED:'原工单已关联', CURSOR_STARTED:'开始复现',
 NEEDS_INFO:'等待补充信息', PR_UPDATED:'修复 PR 已更新', VERIFICATION_FAILED:'独立验证未通过',
 VERIFICATION_PASSED:'独立验证通过', REVIEW_OPENED:'复核窗口开启', CHANGES_REQUESTED:'负责人要求修改',
 MERGE_CONFIRMED:'已核对合并', CLOSED:'已回写原工单和反馈',
};

function FeedbackReviewPanel({entry,observedAt,connected}:{
 entry:FeedbackCase; observedAt:string; connected:boolean;
}) {
 const {review}=entry;
 const [elapsed,setElapsed]=useState(0);
 useEffect(()=>{
  if(!connected||review?.state!=='OPEN')return;
  const observed=performance.now();
  setElapsed(0);
  const timer=setInterval(()=>setElapsed(performance.now()-observed),1000);
  return()=>clearInterval(timer);
 },[connected,review?.state,review?.deadline,observedAt]);
 if(!review)return null;
 const seconds=Math.max(0,Math.ceil((review.deadline-Date.parse(observedAt)-elapsed)/1000));
 const remaining=[Math.floor(seconds/60),seconds%60].map(value=>String(value).padStart(2,'0')).join(':');
 const status=review.state==='VETOED'?'已要求修改':review.state==='CLOSED'?'复核已结束':
  !connected?'等待重新核对':seconds>0?'等待负责人复核':'窗口已到期，等待 Runtime 核对';
 return <section className="panel" aria-labelledby="feedback-review-heading" data-testid="feedback-review">
  <h2 id="feedback-review-heading">人工复核</h2>
  {review.state==='OPEN'?<p><span>复核剩余时间 </span><strong data-testid="feedback-review-countdown"
   style={{display:'block',fontVariantNumeric:'tabular-nums',fontSize:'clamp(2rem,5vw,4rem)'}}>
   {connected?remaining:'待同步'}</strong></p>:null}
  <dl className="details">
   <dt>复核截止时间</dt><dd><time dateTime={new Date(review.deadline).toISOString()} data-testid="feedback-review-deadline">
    {new Date(review.deadline).toLocaleString()}</time></dd>
   <dt>GitHub PR</dt><dd>#{review.pullRequestId}</dd>
   <dt>提交</dt><dd><code title={review.head}>{review.head.slice(0,12)}</code></dd>
   <dt>当前状态</dt><dd>{status}</dd>
  </dl>
 </section>;
}

export function Monitor({session,onAuthLost}:{session:Session;onAuthLost:()=>void}){
 const [page,setPage]=useState<MonitorPage|null>(null),[selected,setSelected]=useState(''),[node,setNode]=useState(''),[message,setMessage]=useState('正在连接实时事件…'),[error,setError]=useState(''),[loading,setLoading]=useState(true),[pages,setPages]=useState(1),[connected,setConnected]=useState(false);
 const [recoveryNotice,setRecoveryNotice]=useState('');
 const [feedback,setFeedback]=useState<FeedbackMonitorPage|null>(null),[feedbackId,setFeedbackId]=useState('');
 const [monitorMode,setMonitorMode]=useState<'feedback'|'base'>('feedback');
 const revision=useRef(0),sequence=useRef(0),pageCount=useRef(pages),refreshPage=useRef<(()=>void)|null>(null);pageCount.current=pages;
 useEffect(()=>{
  let closed=false,source:EventSource|undefined,timer:ReturnType<typeof setTimeout>|undefined,refreshing=false,queued=false,cursor='',streamOpen=false,snapshotReady=false,snapshotFailed=false,requiredRevision=0,recovery:ReplayGap|null=null;sequence.current=0;revision.current=0;setPage(null);setFeedback(null);setFeedbackId('');setSelected('');setNode('');setLoading(true);setRecoveryNotice('');setConnected(false);setError('');setMessage('正在连接实时事件…');
  function syncConnection(){
   const live=streamOpen&&snapshotReady&&recovery===null;setConnected(live);
   setMessage(!streamOpen||snapshotFailed?'实时连接中断，保留最后已核对状态。':recovery?'事件缺口正在核对当前快照。':live?'实时连接已建立':'正在核对实时状态…');
  }
  async function refresh(){if(closed)return;if(refreshing){queued=true;return;}refreshing=true;
   try{let current=await monitor(),all=[...current.instances];for(let n=1;n<pageCount.current&&current.nextAfter;n++){current=await monitor(current.nextAfter,current.revision);all.push(...current.instances);}
    let currentFeedback:FeedbackMonitorPage|null=null;
    if(current.feedbackMonitor===true){
     currentFeedback=await feedbackMonitor();
     const cases=[...currentFeedback.cases];
     for(let n=1;n<pageCount.current&&currentFeedback.nextAfter;n++){
      const next=await feedbackMonitor(currentFeedback.nextAfter,currentFeedback.revision);
      if(next.revision!==currentFeedback.revision||next.projectId!==session.projectId)throw new ApiError('SNAPSHOT_STALE','反馈监控分页发生变化。',409);
      cases.push(...next.cases);
      currentFeedback=next;
     }
     if(currentFeedback.revision!==current.revision||currentFeedback.projectId!==session.projectId)throw new ApiError('SNAPSHOT_STALE','反馈快照已变化，正在重新核对。',409);
     currentFeedback={...currentFeedback,cases};
    }
    if(!closed){
    if(current.projectId!==session.projectId||!counter(current.revision)||current.revision<Math.max(revision.current,requiredRevision,recovery?.resumeRevision??0))throw new ApiError('SNAPSHOT_STALE','恢复快照尚未覆盖当前项目的事件缺口。',409);
    revision.current=current.revision;snapshotReady=true;snapshotFailed=false;setPage({...current,instances:all});setError('');setLoading(false);setSelected(old=>all.some(i=>i.id===old)?old:all[0]?.id??'');
    setFeedback(currentFeedback);
    const cases=currentFeedback?.cases??[];
    setFeedbackId(old=>cases.some(entry=>entry.id===old)?old:cases[0]?.id??'');
    if(recovery){setRecoveryNotice('事件重放存在缺口：项目修订 '+(recovery.afterRevision+1)+'–'+recovery.resumeRevision+' 未逐条重放，已通过修订 '+current.revision+' 的当前快照恢复。');recovery=null;}
    syncConnection();
   }}
   catch(e){if(!closed){snapshotReady=false;snapshotFailed=true;setLoading(false);setError(e instanceof ApiError&&e.code==='TRANSPORT_UNKNOWN'?'Runtime 服务暂时无法连接。':e instanceof Error?e.message:String(e));syncConnection();if(e instanceof ApiError&&e.status===401){closed=true;source?.close();onAuthLost();}}}
   finally{refreshing=false;if(queued&&!closed){queued=false;void refresh();}}
  }
  function reconnect(){if(closed)return;source?.close();source=new EventSource('/api/v1/dashboard/events'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
   source.onopen=()=>{if(!closed){streamOpen=true;syncConnection();}};
   const event=(value:MessageEvent)=>{if(closed)return;try{const data=JSON.parse(String(value.data)) as MonitorEvent;
    if(data.projectId!==session.projectId||typeof data.cursor!=='string'||!data.cursor||!Array.isArray(data.events)||!counter(data.watermark?.sequence)||!counter(data.watermark?.revision)||!Object.hasOwn(data,'gap'))throw Error('事件格式或项目无效');
    requiredRevision=Math.max(requiredRevision,data.watermark.revision);
    if(data.gap!==null){const gap=data.gap;if(value.type!=='reset'||gap.code!=='CURSOR_EXPIRED'||![gap.afterSequence,gap.afterRevision,gap.resumeSequence,gap.resumeRevision,gap.windowEvents].every(counter)||gap.windowEvents!==1000||gap.resumeRevision-gap.afterRevision<=gap.windowEvents||gap.resumeSequence!==data.watermark.sequence||gap.resumeRevision!==data.watermark.revision||data.events.length)throw Error('事件恢复信息无效');
     if(gap.resumeSequence<sequence.current)return;
     cursor=data.cursor;sequence.current=gap.resumeSequence;recovery=gap;snapshotReady=false;syncConnection();setRecoveryNotice('事件重放存在缺口：项目修订 '+(gap.afterRevision+1)+'–'+gap.resumeRevision+' 未逐条重放，正在核对当前快照。');void refresh();return;
    }
    if(value.type==='reset')throw Error('事件恢复信息缺失');
    if(value.type==='snapshot'&&!data.events.length){sequence.current=Math.max(sequence.current,data.watermark.sequence);cursor=data.cursor;void refresh();return;}
    let changed=false,gap=false,observed=revision.current;for(const e of data.events){if(!Number.isSafeInteger(e.seq)||!Number.isSafeInteger(e.revision))throw Error('事件序号无效');if(e.seq<=sequence.current)continue;sequence.current=e.seq;if(e.revision>observed){if(e.revision>observed+1)gap=true;observed=e.revision;changed=true;}}
    cursor=data.cursor;if(changed||!revision.current){
     if(requiredRevision>revision.current){snapshotReady=false;syncConnection();}
     void refresh();
    }
    if(gap)setMessage('事件存在间隔，已请求完整快照核对。');else syncConnection();
   }catch{setMessage('事件无法连续读取，正在重建快照。');streamOpen=false;snapshotReady=false;source?.close();setConnected(false);cursor='';sequence.current=0;void refresh();if(timer)clearTimeout(timer);timer=setTimeout(reconnect,3000);}};
   for(const name of ['snapshot','events','heartbeat','reset'])source.addEventListener(name,event as EventListener);
   source.addEventListener('error',e=>{if(closed)return;source?.close();streamOpen=false;snapshotReady=false;syncConnection();
    if(e instanceof MessageEvent){try{const code=(JSON.parse(String(e.data)) as {code:string}).code;if(['UNAUTHENTICATED','FORBIDDEN','BROWSER_SESSION_REVOKED','BROWSER_SESSION_EXPIRED'].includes(code)){closed=true;onAuthLost();return;}if(code==='INVALID_CURSOR'){cursor='';sequence.current=0;}}catch{/* A malformed stream requires a fresh snapshot. */}}
    // A transport failure does not invalidate the last authenticated cursor.
    // Retaining it lets the service distinguish replay from a real gap.
    void refresh();if(timer)clearTimeout(timer);timer=setTimeout(reconnect,3000);
   });
  }
  refreshPage.current=()=>void refresh();void refresh();reconnect();const poll=setInterval(()=>void refresh(),10000);
  return()=>{closed=true;refreshPage.current=null;source?.close();if(timer)clearTimeout(timer);clearInterval(poll);};
 },[session.serviceId,session.projectId,session.principalId,session.csrf]);
 useEffect(()=>{if(pages>1)refreshPage.current?.();},[pages]);
 const instance=page?.instances.find(i=>i.id===selected),stage=instance?.stages[node];
 const feedbackCase=feedback?.cases.find(entry=>entry.id===feedbackId);
 return <><div className="page-heading"><div><p className="eyebrow">LIVE LIFECYCLE</p><h1>生命周期监控</h1><p>跟踪实际实例与阶段回执。此页面只读。</p></div><span className={'connection '+(connected?'online':'offline')}>{connected?'● 实时连接':'○ 连接中断'}</span></div>
  <div className="monitor-strip" role="status" data-project-id={page?.projectId} data-snapshot-revision={page?.revision} data-snapshot-observed-at={page?.observedAt}><span>{message}</span><span>{page?'最近核对 '+new Date(page.observedAt).toLocaleTimeString():''}</span></div>
  {recoveryNotice?<div className="notice" role="status" data-testid="monitor-recovery">{recoveryNotice}</div>:null}
  {error?<div role="alert" className="notice error">{error} 当前显示结果不代表持续在线。</div>:null}
  {feedback?.cases.length&&page?.instances.length?<div className="button-row" aria-label="监控类型">
   <button type="button" aria-pressed={monitorMode==='feedback'} onClick={()=>setMonitorMode('feedback')}>反馈流程</button>
   <button type="button" aria-pressed={monitorMode==='base'} onClick={()=>setMonitorMode('base')}>常规实例</button>
  </div>:null}
  {feedback&&feedbackCase&&(monitorMode==='feedback'||!page?.instances.length)?
   <div data-testid="feedback-monitor" data-snapshot-revision={feedback.revision}
    data-snapshot-observed-at={feedback.observedAt} data-stale={!connected}>
    <section className="panel instance-select"><label htmlFor="feedback-case">反馈案件</label>
     <select id="feedback-case" value={feedbackId} onChange={event=>setFeedbackId(event.target.value)}>
      {feedback.cases.map(entry=><option key={entry.id} value={entry.id}>{entry.id}</option>)}
     </select>
     {feedback.nextAfter?<button type="button" onClick={()=>setPages(value=>value+1)}>加载更多案件</button>:null}
     <span className="muted">只读 · {feedbackStageLabels[feedbackCase.stage]} · {feedbackStatusLabels[feedbackCase.status]}</span>
    </section>
    <div style={{display:'flex',flexWrap:'wrap',gap:'1rem'}}>
    <div style={{flex:'3 1 36rem',minWidth:0}}>
    <FeedbackMonitorGraph entry={feedbackCase}/>
    <section className="panel" aria-labelledby="feedback-events-heading"><h2 id="feedback-events-heading">实时事件时间线</h2>
     {[...feedbackCase.timeline].reverse().map(event=><details key={event.id} data-feedback-event={event.id}>
      <summary><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time>
       {' · '}{reasonLabels[event.reason]??feedbackStageLabels[event.stage]}{' · '}{feedbackStatusLabels[event.status]}</summary>
      <dl className="details"><dt>事件原因</dt><dd><code>{event.reason}</code></dd>
       <dt>原始回执</dt><dd><code>{event.ref??'尚无回执'}</code></dd>
       {event.returnFrom?<><dt>回退路径</dt><dd>{feedbackStageLabels[event.returnFrom]} → {feedbackStageLabels[event.stage]}</dd></>:null}
      </dl>
     </details>)}
    </section>
    </div>
    {feedbackCase.review?<aside style={{flex:'1 1 15rem',minWidth:0}}>
     <FeedbackReviewPanel entry={feedbackCase} observedAt={feedback.observedAt} connected={connected}/>
    </aside>:null}
    </div>
   </div>:loading?<div className="panel" role="status">正在读取生命周期实例…</div>:!page?.instances.length?<section className="panel empty"><h2>暂无生命周期实例</h2><p>项目定义启用后，仍需通过 Expert 显式绑定目标并建立实例。监控不会启动任务。</p></section>:<>
   <section className="panel instance-select"><label htmlFor="instance">生命周期实例</label><select id="instance" value={selected} onChange={e=>{setSelected(e.target.value);setNode('');}}>{page.instances.map(i=><option key={i.id} value={i.id}>{i.id}</option>)}</select>{page.nextAfter?<button type="button" onClick={()=>setPages(n=>n+1)}>加载更多实例</button>:null}<span className="muted">已读取 {page.instances.length} 个实例</span></section>
   {instance?<><div className="instance-pins"><div><span>固定定义修订</span><code title={instance.definitionRevisionId}>{instance.definitionRevisionId}</code></div><div><span>Goal / Target / Loop</span><code>{instance.goalRef} / {instance.targetRef} / {instance.loopRef}</code></div><div><span>Base 版本</span><strong>{instance.base.id} @{instance.base.version}</strong></div></div>
    <Graph nodes={instance.graph} states={instance.stages} selected={node} onSelect={setNode}/>
    <section className="panel"><div className="section-heading"><h2>阶段状态</h2><span className="muted">未知结果不会计为通过</span></div><div className="table-scroll"><table><thead><tr><th>阶段</th><th>状态</th><th>尝试</th><th>请求 / 回执</th><th>请求时间</th></tr></thead><tbody>{instance.graph.map(n=>{const s=instance.stages[n.id];return <tr key={n.id} data-selected={node===n.id}><td><button type="button" className="text-button" onClick={()=>setNode(n.id)}>{stageLabels[n.id]??n.id}</button><small>{n.source==='base'?'Base':'项目扩展'}</small></td><td><span className={'status '+s.status}>{labels[s.status]}</span></td><td>{s.attempts}</td><td><code>{s.requestId??'尚无请求'}</code><small>{s.receiptRef??'尚无回执'}</small></td><td>{s.requestedAt?new Date(s.requestedAt).toLocaleString():'—'}</td></tr>;})}</tbody></table></div></section>
    {stage?<section className="panel"><h2>{stageLabels[node]??node} · 观测详情</h2><dl className="details"><dt>状态</dt><dd>{labels[stage.status]}</dd><dt>原请求</dt><dd>{stage.requestId??'尚无请求'}</dd><dt>回执引用</dt><dd>{stage.receiptRef??'尚无回执'}</dd><dt>结果摘要</dt><dd>{stage.outcomeDigest??'尚无结果'}</dd><dt>有效期</dt><dd>{stage.expiresAt??'尚未执行'}</dd></dl></section>:null}
   </>:null}
  </>}
 </>;
}
