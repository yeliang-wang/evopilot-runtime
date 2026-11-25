import {useEffect,useRef,useState,type ReactNode} from 'react';
import {stringify} from 'yaml';
import {Graph} from './Graph';
import {ApiError,call,source as readSource,savePending,loadPending,clearPending,recordCompletedAuthorityResponse,FEEDBACK_DRAFT_SAVE,inspectFeedbackDraft,validateFeedbackDraft,writeFeedbackDraft} from './api';
import type {FeedbackDraftView,FeedbackDraftReceipt} from './api';
import {addExtension,at,changeExtension,changeField,connectExtension,data,diffLines,document as yamlDocument,draftNodes,displayValue,extensions,fieldValue,moveNode,removeExtension,stageLabels} from './model';
import type {Base,BaseTransitionPreview,DefinitionView,Field,GraphNode,Issue,Pending,Receipt,Session,Validation} from './types';

function BaseTransition({value}:{value:BaseTransitionPreview}){
 return <div className="base-transition" data-testid="base-transition"><h3>Base 升级差异</h3>
  <p>原定义：<strong>{value.from.id} @{value.from.version}</strong> → 当前发布版本：<strong>{value.to.id} @{value.to.version}</strong></p>
  <p>升级不会自动修改 YAML 或删除扩展。请处理以下差异，重新校验后启用；历史实例仍保留原版本。</p>
  <h4>新增必填配置</h4>{value.addedRequiredFields.length?<ul>{value.addedRequiredFields.map(field=><li key={field}><code>{field}</code></li>)}</ul>:<p>无新增必填配置。</p>}
  <h4>移除的扩展槽位</h4>{value.removedSlots.length?<ul>{value.removedSlots.map(slot=><li key={slot}><code>{slot}</code></li>)}</ul>:<p>无移除的槽位。</p>}
  <h4>收紧的约束</h4>{value.tightenedConstraints.length?<ul>{value.tightenedConstraints.map((change,index)=><li key={change.path+'-'+index}><code>{change.path}</code><p>原约束：<code>{JSON.stringify(change.before)}</code></p><p>当前约束：<code>{JSON.stringify(change.after)}</code></p></li>)}</ul>:<p>无收紧的约束。</p>}
  <p>Schema：<code>{value.from.schemaVersion}</code>{value.schemaChanged?<> → <code>{value.to.schemaVersion}</code>，需要重新校验。</>:'，版本未变。'}</p>
  <h4>保留的原项目扩展</h4>{value.retainedExtensionIds.length?<ul>{value.retainedExtensionIds.map(id=><li key={id}><code>{id}</code></li>)}</ul>:<p>原定义无项目扩展。</p>}
  {value.issues.length?<ul className="issues">{value.issues.map((issue,index)=><li key={issue.path+'-'+index}><code>{issue.path}</code><strong>{issue.code}</strong><p>{issue.message}</p><small>{issue.remedy}</small></li>)}</ul>:null}
  <details><summary>核对原修订与版本摘要</summary><dl><dt>原定义修订</dt><dd><code>{value.sourceRevisionId}</code></dd><dt>原 Base 摘要</dt><dd><code>{value.from.digest}</code></dd><dt>当前 Base 摘要</dt><dd><code>{value.to.digest}</code></dd><dt>本次差异摘要</dt><dd><code>{value.previewDigest}</code></dd></dl></details>
 </div>;
}

function FieldInput({field,value,disabled,onChange}:{field:Field;value:unknown;disabled:boolean;onChange:(value:unknown)=>void}){
 const [text,setText]=useState(displayValue(value)),[error,setError]=useState('');useEffect(()=>setText(displayValue(value)),[value]);
 function update(v:string){setText(v);try{onChange(fieldValue(v,field.type));setError('');}catch(e){setError(String(e));}}
 const id='field-'+field.id,locked=field.policy==='LOCKED';return <div className="field"><label htmlFor={id}>{field.question||field.path}<small>{field.path} · {locked?'Base 锁定':field.policy==='CONSTRAINED'?'受约束配置':'项目配置'}</small></label>
 {field.type==='enum'&&Array.isArray(field.rules.values)?<select id={id} value={text} disabled={disabled||locked} onChange={e=>update(e.target.value)}>{field.rules.values.map(v=><option key={String(v)} value={String(v)}>{String(v)}</option>)}</select>:<input id={id} value={text} disabled={disabled||locked} aria-invalid={!!error} onChange={e=>setText(e.target.value)} onBlur={()=>{if(text!==displayValue(value))update(text);}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();update(text);}}}/>}
 {error?<span className="field-error" role="alert">{error}</span>:null}</div>;
}
interface EditorProps {session:Session;onDirty:(value:boolean)=>void;onAuthLost:()=>void;}

function BaseEditor({session,onDirty,onAuthLost}:EditorProps){
 const [base,setBase]=useState<Base|null>(null),[view,setView]=useState<DefinitionView|null>(null),[text,setText]=useState(''),[saved,setSaved]=useState(''),[activeSource,setActiveSource]=useState(''),[selected,setSelected]=useState('scope'),[validation,setValidation]=useState<Validation|null>(null),[validatedSource,setValidatedSource]=useState(''),[previewSource,setPreviewSource]=useState<string|null>(null),[previewValidation,setPreviewValidation]=useState<Validation|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[pending,setPending]=useState<Pending|null>(()=>loadPending(session)),[conflict,setConflict]=useState(false),[extensionJson,setExtensionJson]=useState(''),[addId,setAddId]=useState(''),[addSlot,setAddSlot]=useState('after-plan'),[addAction,setAddAction]=useState(''),[connectFrom,setConnectFrom]=useState('');
 const isLimitedPreview='distributionProfile' in session && session.distributionProfile==='limited-preview';
 const latest=useRef(text);latest.current=text;const mounted=useRef(true),canEdit=session.permissions.includes('draft.write'),canActivate=canEdit&&session.permissions.includes('definition.activate');
 function fail(error:unknown){const e=error instanceof Error?error.message:String(error);setMessage(e);if(error instanceof ApiError){if(error.status===401)onAuthLost();if(error.code==='REVISION_CONFLICT')setConflict(true);}}
 async function reload(overwrite:boolean,committedRevision?:number){setLoading(true);try{const [b,v]=await Promise.all([call<Base>(session,'lifecycle.base.inspect'),call<DefinitionView>(session,'lifecycle.definition.inspect')]);const sourceId=v.draft?.id??v.active?.id;const [draft,active]=await Promise.all([sourceId?readSource(session,sourceId):Promise.resolve(''),v.active?readSource(session,v.active.id):Promise.resolve('')]);if(!mounted.current)return;setBase(b);setView(v);setActiveSource(active);if(overwrite){setText(draft);setSaved(draft);setPreviewSource(null);setValidation(null);setConflict(false);}else if(committedRevision!==undefined&&v.revision!==committedRevision){setConflict(true);setMessage('本次保存已有回执，但服务端又产生了后续修订。请核对新版本后继续。');}setAddAction(a=>a||b.actions[0]?.id||'');}catch(e){fail(e);}finally{if(mounted.current)setLoading(false);}}
 useEffect(()=>{mounted.current=true;void reload(true);return()=>{mounted.current=false;onDirty(false);};},[session.serviceId,session.projectId]);
 useEffect(()=>{onDirty(text!==saved);},[text,saved]);
 useEffect(()=>{if(!text){setValidation(null);return;}const controller=new AbortController();const timer=setTimeout(()=>{void call<Validation>(session,'lifecycle.definition.validate',{yaml:text},{},controller.signal).then(v=>{if(!controller.signal.aborted&&latest.current===text){setValidation(v);setValidatedSource(text);}}).catch(e=>{if(!controller.signal.aborted)fail(e);});},450);return()=>{clearTimeout(timer);controller.abort();};},[text,session]);
 let parsed:Record<string,unknown>|null=null,parseError='';try{if(text)parsed=data(text);}catch(e){parseError=e instanceof Error?e.message:String(e);}
 const currentValidation=validatedSource===text?validation:null;
 const nodes:GraphNode[]=currentValidation?.compilation.effective?.nodes??(base?draftNodes(base,parsed):[]);
 const selectedNode=nodes.find(n=>n.id===selected),list=(()=>{try{return text?extensions(text):[];}catch{return[];}})(),entry=list.find(e=>e.id===selected);
 useEffect(()=>{setExtensionJson(entry?JSON.stringify(entry,null,2):'');},[text,selected]);
 const layout=parsed&&at(parsed,'presentation.layout') as Record<string,{x:number;y:number}>|undefined;
 const issues:Issue[]=currentValidation?.issues??[];const locked=busy||loading||!canEdit||!!pending||conflict;
 function edit(update:()=>string){try{setText(update());setPreviewSource(null);setMessage('');}catch(e){fail(e);}}
 async function preview(){setBusy(true);try{const original=latest.current,v=await call<Validation>(session,'lifecycle.definition.validate',{yaml:original});if(original!==latest.current)return;setValidation(v);setValidatedSource(original);setPreviewSource(original);setPreviewValidation(v);setMessage(v.ready?'校验通过。请核对下方与当前生效版本的差异，再保存并启用。':'配置尚未就绪，请处理下方缺项。');}catch(e){fail(e);}finally{setBusy(false);}}
 function accept(receipt:Receipt,submitted?:string){clearPending(session);setPending(null);setMessage(receipt.result.status==='ACTIVE'?'已启用此精确定义。既有实例继续使用原版本。':receipt.result.status==='BLOCKED'?'启用被门禁阻止，草稿已保留，原生效版本未变。':'草稿已保存。');setView(v=>v?{...v,revision:receipt.revision}:v);if(submitted!==undefined)setSaved(submitted);setPreviewSource(null);void reload(false,receipt.revision);}
 async function save(activate:boolean){if(!view)return;const original=latest.current;if(activate&&(previewSource!==original||!previewValidation?.ready))return;const operation=activate?'lifecycle.definition.save-and-activate':'lifecycle.draft.save';let p:Pending;
  try{p=savePending(session,operation);setPending(p);}catch{setMessage('浏览器无法保留请求身份，暂未提交。请检查会话存储。');return;}
  setBusy(true);try{const receipt=await call<Receipt>(session,operation,{yaml:original,...(activate?{validationDigest:previewValidation?.validationDigest}: {})},{requestId:p.requestId,expectedRevision:view.revision});accept(receipt,original);}catch(e){
   // A definite pre-commit rejection can be corrected. Transport/5xx/authority
   // uncertainty keeps the original request ID and disables new mutations.
   if(e instanceof ApiError&&['REVISION_CONFLICT','INVALID_INPUT','INLINE_SECRET','YAML_LIMIT','INVALID_REFERENCE','INVALID_FIELDS'].includes(e.code)){clearPending(session);setPending(null);}
   else{try{const observed=recordCompletedAuthorityResponse(session,p,e);if(observed)setPending(observed);}catch{/* Failed persistence retains the original UNKNOWN request. */}}fail(e);
  }finally{setBusy(false);}}
 async function inspectPending(){if(!pending)return;setBusy(true);try{
  const receipt=await call<Receipt>(session,'runtime.receipt.read',{requestId:pending.requestId});if(receipt.requestId!==pending.requestId||receipt.operation!==pending.operation||receipt.projectId!==pending.projectId||receipt.principalId!==pending.principalId)throw Error('回执与原请求不一致。');accept(receipt);setMessage('已找到原请求回执。请重新读取已保存定义，再继续修改。');setConflict(true);
 }catch(e){
  if(e instanceof ApiError&&e.status===404&&e.code==='NOT_FOUND'){
   if(pending.completedAuthorityResponse){
    // A complete synchronous definition-write reply can still follow a commit
    // (the server rechecks authority after dispatch). Only this exact receipt
    // read distinguishes it. A missing receipt for an UNKNOWN request cannot.
    try{clearPending(session,pending);setPending(null);setPreviewSource(null);setPreviewValidation(null);setMessage('原请求已明确结束且未提交。当前 YAML 已保留，请重新校验后再提交。');}catch(error){fail(error);}
   }else setMessage('原请求尚无已提交回执；保留请求身份，未重复提交。');
  }else fail(e);
 }finally{setBusy(false);}}
 if(loading&&!base)return <div className="panel" role="status">正在读取项目定义…</div>;
 return <><div className="page-heading"><div><p className="eyebrow">PROJECT LIFECYCLE</p><h1>生命周期定义</h1><p>图形和 YAML，共用同一份配置。</p></div><div className="badges"><span className="badge">{text===saved?'已保存':'有未保存变更'}</span><span className="badge">{view?.active?'已有生效版本':'尚未启用'}</span></div></div>
  {message?<div className="notice" role="status">{message}</div>:null}
  {!canEdit?<div className="notice">当前身份仅可浏览定义。</div>:null}
  {pending?<div className="notice warning">待核对原请求 <code>{pending.requestId}</code>。<button type="button" disabled={busy} onClick={()=>void inspectPending()}>核对原请求</button></div>:null}
  {conflict?<div className="notice warning">服务端版本已变化或需重新读回。当前编辑内容仍保留。<button type="button" disabled={busy} onClick={()=>{if(text===saved||window.confirm('重新读取将替换当前未保存内容，是否继续？'))void reload(true);}}>重新读取</button><button type="button" onClick={()=>void navigator.clipboard.writeText(text).then(()=>setMessage('已复制当前 YAML。')).catch(()=>setMessage('无法访问剪贴板，请在源码框中复制。'))}>复制当前 YAML</button></div>:null}
  {base?<div className="base-banner"><span>{currentValidation?.baseTransition?<>原定义继承 <strong>{currentValidation.baseTransition.from.id} @{currentValidation.baseTransition.from.version}</strong> · 当前发布版本 <strong>{base.pin.version}</strong></>:<>继承 <strong>{base.pin.id} @{base.pin.version}</strong></>}</span><span>Base 由 Runtime 发布者维护 · 配置修订 {view?.revision??0}</span></div>:null}
  <p className="muted" role="status">{currentValidation?.compilation.valid?'图形已与当前源码结构核对；启用仍需全部配置与绑定校验通过。':'草稿图形预览 · 当前源码尚未通过结构校验，不代表可启用。'}</p>
  <Graph nodes={nodes} layout={layout??{}} selected={selected} onSelect={setSelected} onMove={locked||!parsed?undefined:(id,x,y)=>edit(()=>moveNode(text,nodes,id,x,y))}/>
  <div className="editor-grid"><section className="panel properties"><div className="section-heading"><h2>{stageLabels[selected]??selected}</h2><span className="badge">{selectedNode?.source==='project'?'项目扩展':'Base 阶段'}</span></div>
   <p className="muted">{selectedNode?.source==='project'?'项目扩展可在发布者允许的槽位内调整；所有检查必须同时通过。':'流程依赖与必需检查锁定。下方仅可修改 Base 允许的项目参数。'}</p>
   {selectedNode?.source==='base'&&base?base.fields.filter(f=>f.stage===selected&&f.providers.includes(String(at(parsed,'config.implementation.provider')))).map(f=><FieldInput key={f.path} field={f} value={at(parsed,f.path)} disabled={locked||!parsed} onChange={v=>edit(()=>changeField(text,f,v))}/>):null}
   {entry?<><label htmlFor="extension-properties">扩展属性（JSON）</label><textarea id="extension-properties" rows={16} value={extensionJson} disabled={locked} onChange={e=>setExtensionJson(e.target.value)}/><div className="button-row"><button type="button" disabled={locked} onClick={()=>edit(()=>changeExtension(text,selected,JSON.parse(extensionJson) as Record<string,unknown>))}>应用扩展属性</button><button type="button" disabled={locked} onClick={()=>edit(()=>removeExtension(text,selected))}>删除项目扩展</button></div>
    <label htmlFor="dependency">同槽位前置节点</label><select id="dependency" value={connectFrom} disabled={locked} onChange={e=>setConnectFrom(e.target.value)}><option value="">选择项目节点</option>{list.filter(e=>e.id!==selected&&e.slot===entry.slot).map(e=><option key={String(e.id)} value={String(e.id)}>{String(e.id)}</option>)}</select><div className="button-row"><button disabled={locked||!connectFrom} onClick={()=>edit(()=>connectExtension(text,connectFrom,selected,true))}>添加依赖</button><button disabled={locked||!connectFrom} onClick={()=>edit(()=>connectExtension(text,connectFrom,selected,false))}>移除依赖</button></div></>:null}
   {base?<details><summary>添加项目扩展</summary><label htmlFor="extension-id">扩展标识</label><input id="extension-id" placeholder="project.security-check" value={addId} disabled={locked} onChange={e=>setAddId(e.target.value)}/><label htmlFor="extension-slot">允许的插入槽位</label><select id="extension-slot" value={addSlot} disabled={locked} onChange={e=>{const slot=e.target.value;setAddSlot(slot);setAddAction(base.actions.find(a=>base.slots[slot]?.types.includes(a.type))?.id??'');}}>{Object.keys(base.slots).map(s=><option key={s}>{s}</option>)}</select><label htmlFor="extension-action">发布者动作</label><select id="extension-action" value={addAction} disabled={locked} onChange={e=>setAddAction(e.target.value)}>{base.actions.filter(a=>base.slots[addSlot]?.types.includes(a.type)).map(a=><option key={a.id} value={a.id}>{a.id} @{a.version}</option>)}</select><button type="button" disabled={locked||!text} onClick={()=>{edit(()=>addExtension(text,base,addId,addSlot,addAction));}}>加入草稿</button><p className="muted">新增后必须补齐需求、证据映射、参数和预算，才能启用。</p></details>:null}
  </section><section className="panel source-panel"><div className="section-heading"><h2>YAML 源码</h2><span className="muted">注释保留 · YAML 1.2</span></div><label className="sr-only" htmlFor="lifecycle-yaml">Project Lifecycle YAML</label><textarea id="lifecycle-yaml" className="code-editor" spellCheck={false} value={text} readOnly={locked} onChange={e=>{setText(e.target.value);setPreviewSource(null);}} placeholder="由 Runtime Expert 接入项目并生成定义后，在此浏览和编辑。"/>
   {parseError?<p className="field-error" role="alert">{parseError} 图形仅显示 Base 参考，不代表当前草稿有效。</p>:null}
   <div className="button-row"><button type="button" disabled={locked||!text} onClick={()=>void save(false)}>保存草稿</button><button type="button" disabled={busy||loading||!text||!!pending} onClick={()=>void preview()}>校验与差异预览</button>{!isLimitedPreview?<button type="button" className="primary" disabled={locked||!canActivate||previewSource!==text||!previewValidation?.ready} onClick={()=>void save(true)}>保存并启用</button>:null}</div>
   <p className="muted">{isLimitedPreview?'此预发行仅保存和校验本地草稿。':'定义启用仅供后续新实例使用，不启动任务、不批准资产或软件发布。'}</p>
  </section></div>
  {previewSource!==null?<section className="panel diff"><h2>与当前生效版本的准确差异</h2>{previewValidation?.baseTransition?<BaseTransition value={previewValidation.baseTransition}/>:null}<pre tabIndex={0}>{diffLines(activeSource,text)}</pre></section>:null}
  {issues.length?<section className="panel"><h2>需要处理的配置（{issues.length}）</h2><ul className="issues">{issues.map((i,n)=><li key={n}><code>{i.path}</code><strong>{i.code}</strong><p>{i.message}</p><small>{i.remedy}</small></li>)}</ul></section>:null}
 </>;
}

const bindingLabels = {
 feedbackBindingRef: '反馈通道',
 linearTeamRef: 'Linear 团队',
 cursorAgentRef: 'Cursor Agent',
 githubRepositoryRef: 'GitHub 仓库',
 harnessRuleRef: 'Harness 校验规则',
 reviewBindingRef: '复核通道',
 mergePolicyRef: '合并策略',
} as const;
type BindingField = keyof typeof bindingLabels;

const feedbackStages = [
 {id:'receive-feedback',label:'接收反馈',field:'feedbackBindingRef',icon:'M20 11a8 8 0 0 1-8 8H4l2-4a8 8 0 1 1 14-4Z'},
 {id:'create-issue',label:'建单',field:'linearTeamRef',icon:'M6 3h8l4 4v14H6Z M14 3v5h4 M9 14h6 M12 11v6'},
 {id:'reproduce',label:'复现',field:'cursorAgentRef',icon:'M9 6 6 3 M15 6l3-3 M4 10h4 M16 10h4 M4 16h4 M16 16h4 M8 11a4 4 0 1 1 8 0v5a4 4 0 1 1-8 0Z M8 12h8 M12 12v8'},
 {id:'repair-pr',label:'修复 PR',field:'githubRepositoryRef',icon:'M7 6a2 2 0 1 0 0 .01 M7 20a2 2 0 1 0 0 .01 M19 8a2 2 0 1 0 0 .01 M5 8v10 M5 15h4a8 8 0 0 0 8-5'},
 {id:'verify',label:'独立验证',field:'harnessRuleRef',icon:'m12 3 8 3v5a11 11 0 0 1-8 10 11 11 0 0 1-8-10V6Z M8 12l3 3 5-5'},
 {id:'review',label:'人工复核',field:'reviewBindingRef',icon:'M17 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z M4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2'},
 {id:'merge-writeback',label:'合并与回写',field:'mergePolicyRef',icon:'M7 5a2 2 0 1 0 0 .01 M7 20a2 2 0 1 0 0 .01 M19 16a2 2 0 1 0 0 .01 M5 7v11 M5 10h7a5 5 0 0 1 5 4'},
] as const;
type FeedbackStage = typeof feedbackStages[number];
const feedbackReturns = [
 {label:'补充信息',path:'M380 80 V48 Q380 34 366 34 H96 Q82 34 82 48 V78',x:174,y:20},
 {label:'要求修改',path:'M835 80 V58 Q835 44 821 44 H550 Q536 44 536 58 V78',x:646,y:30},
 {label:'验证失败',path:'M683 134 V162 Q683 176 669 176 H394 Q380 176 380 162 V136',x:493,y:162},
] as const;

function FeedbackGraph({selected,onSelect,children}:{
 selected: FeedbackStage | null;
 onSelect: (stage:FeedbackStage)=>void;
 children: ReactNode;
}){
 return <section className="graph-card" aria-labelledby="feedback-graph-heading">
  <header className="graph-toolbar section-heading"><h2 id="feedback-graph-heading">流程图</h2></header>
  <div className="table-scroll">
   <svg className="sc-svg" width="1068" height="205" viewBox="0 0 1068 205" aria-label="反馈生命周期流程和返回路径">
    <defs>
     <marker id="feedback-next" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path d="M0 0 L7 3.5 L0 7 Z" fill="#4038db"/>
     </marker>
     <marker id="feedback-return" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path d="M0 0 L7 3.5 L0 7 Z" fill="#bd7100"/>
     </marker>
    </defs>
    {feedbackReturns.map(({label,path,x,y})=><g key={label}>
     <path d={path} fill="none" stroke="#bd7100" strokeWidth="1.6" strokeDasharray="6 4" markerEnd="url(#feedback-return)"/>
     <rect x={x} y={y} width="88" height="27" rx="7" fill="#fff0d6" stroke="#e9b460"/>
     <text x={x+44} y={y+18} textAnchor="middle" fontSize="14" fontWeight="650" fill="#824400">{label}</text>
    </g>)}
    {feedbackStages.slice(1).map(({id},index)=>{
     const start=149+151*index;
     return <line key={id} x1={start} x2={start+17} y1="107" y2="107" stroke="#4038db" strokeWidth="1.6" markerEnd="url(#feedback-next)"/>;
    })}
    {feedbackStages.map((stage,index)=>{
     const merge=stage.id==='merge-writeback';
     const stroke=selected?.id===stage.id?'#2921b8':merge?'#128134':'#746cff';
     return <g key={stage.id} role="button" tabIndex={0} data-sc-node={stage.id}
      aria-pressed={selected?.id===stage.id} aria-controls={selected?.id===stage.id?'feedback-node-configuration':undefined}
      aria-label={stage.label} transform={`translate(${14+151*index} 80)`}
      onClick={()=>onSelect(stage)} onKeyDown={event=>{
       if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(stage);}
      }}>
      <rect width="134" height="54" rx="9" fill={merge?'#e4f9e9':selected?.id===stage.id?'#e2dfff':'#f0efff'}
       stroke={stroke} strokeWidth={selected?.id===stage.id?2.5:1.2}/>
      <path d={stage.icon} transform="translate(10 15)" fill="none" stroke={merge?'#087733':'#4038db'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <text x="42" y="33" fontSize="15" fontWeight="650" fill={merge?'#0b6a2b':'#181936'}>{stage.label}</text>
     </g>;
    })}
   </svg>
  </div>
  {children}
 </section>;
}

const feedbackSourceLimit=16_384;
const definiteDraftErrors=new Set([
 'REVISION_CONFLICT','INVALID_FIELDS','INVALID_INPUT','INVALID_REVISION','INVALID_REFERENCE',
 'INLINE_SECRET','FEEDBACK_YAML_LIMIT','FEEDBACK_YAML_INVALID','FEEDBACK_BINDING_REFERENCE',
 'FEEDBACK_REVIEW_WINDOW','FEEDBACK_PROJECT_SCOPE',
]);

function draftSource(view: FeedbackDraftView, session: Session){
 return view.draft?.yaml ?? stringify(view.draft?.configuration ?? {
  workspaceId:session.workspaceId,projectId:session.projectId,reviewWindowMinutes:60,
 },{lineWidth:0});
}

function FeedbackEditor({session,onDirty,onAuthLost,initialView}:EditorProps & {initialView:FeedbackDraftView}){
 const [view,setView]=useState(initialView);
 const [saved,setSaved]=useState(()=>draftSource(initialView,session));
 const [text,setText]=useState(saved);
 const [selected,setSelected]=useState<FeedbackStage|null>(null);
 const [message,setMessage]=useState<{text:string;error?:boolean}|null>(null);
 const [busy,setBusy]=useState(false);
 const inFlight=useRef(false);
 const [pending,setPending]=useState(()=>loadPending(session));
 const [conflict,setConflict]=useState(false);
 const canEdit=session.permissions.includes('draft.write');
 const locked=busy||!!pending||conflict||!canEdit;
 const withinLimit=new TextEncoder().encode(text).length<=feedbackSourceLimit;
 const dirty=text!==saved;
 useEffect(()=>{onDirty(dirty);},[dirty]);
 useEffect(()=>()=>onDirty(false),[]);

 let fields:Record<string,unknown>|null=null;
 let syntaxError='';
 if(withinLimit){
  try{fields=data(text);}catch(error){syntaxError=error instanceof Error?error.message:String(error);}
 }

 function fail(error:unknown){
  setMessage({text:error instanceof Error?error.message:String(error),error:true});
  if(error instanceof ApiError){
   if(error.status===401)onAuthLost();
   if(error.code==='REVISION_CONFLICT')setConflict(true);
  }
 }
 async function run(action:()=>Promise<void>){
  if(inFlight.current)return;
  inFlight.current=true;
  setBusy(true);
  setMessage(null);
  try{await action();}catch(error){fail(error);}finally{inFlight.current=false;setBusy(false);}
 }
 function change(next:string){
  setText(next);
  setMessage(null);
 }
 function editField(field:BindingField,value:string){
  try{
   const document=yamlDocument(text);
   if(value)document.set(field,value);
   else document.delete(field);
   change(document.toString({lineWidth:0}));
  }catch(error){fail(error);}
 }
 function useReadback(next:FeedbackDraftView){
  const source=draftSource(next,session);
  setView(next);
  setText(source);
  setSaved(source);
  setConflict(false);
 }
 async function validate(){
  const result=await validateFeedbackDraft(session,text);
  if(result.structure!=='VALID')throw new Error('Runtime 未确认 YAML 校验通过。');
  setMessage({text:'YAML 结构校验通过。绑定核对与精确启用由 Codex Runtime Expert 完成。'});
 }
 async function accept(receipt:FeedbackDraftReceipt,original:Pending,submitted?:string){
  if(receipt.requestId!==original.requestId||receipt.operation!==FEEDBACK_DRAFT_SAVE||
    receipt.projectId!==original.projectId||receipt.principalId!==original.principalId||
    receipt.result.status!=='DRAFT'){
   throw new Error('回执与原请求不一致。');
  }
  if(submitted!==undefined&&(receipt.result.yaml!==submitted||!receipt.result.yamlDigest)){
   throw new Error('保存回执与提交的 YAML 不一致。');
  }
  const next=await inspectFeedbackDraft(session);
  clearPending(session,original);
  setPending(null);
  if(next.draft?.draftDigest!==receipt.result.draftDigest||next.draft?.yaml!==receipt.result.yaml||
    next.draft?.yamlDigest!==receipt.result.yamlDigest){
   setConflict(true);
   setMessage({text:'原请求已保存，服务端当前草稿已更新。请重新读取草稿。'});
   return;
  }
  useReadback(next);
  setMessage({text:'草稿已保存并读回。'});
 }
 async function save(){
  const original=savePending(session,FEEDBACK_DRAFT_SAVE);
  setPending(original);
  let receipt:FeedbackDraftReceipt;
  try{
   receipt=await writeFeedbackDraft(session,text,original.requestId,view.revision);
  }catch(error){
   if(error instanceof ApiError&&definiteDraftErrors.has(error.code)){
    clearPending(session,original);
    setPending(null);
   }else{
    const observation=recordCompletedAuthorityResponse(session,original,error);
    if(observation)setPending(observation);
   }
   throw error;
  }
  await accept(receipt,original,text);
 }
 async function reconcile(){
  if(!pending)return;
  let receipt:FeedbackDraftReceipt;
  try{
   receipt=await call<FeedbackDraftReceipt>(session,'runtime.receipt.read',{requestId:pending.requestId});
  }catch(error){
   if(!(error instanceof ApiError&&error.status===404&&error.code==='NOT_FOUND'))throw error;
   if(pending.completedAuthorityResponse){
    clearPending(session,pending);
    setPending(null);
    setMessage({text:'原请求已结束且未提交。当前 YAML 已保留。'});
   }else{
    setMessage({text:'原请求尚无回执，请继续核对。'});
   }
   return;
  }
  await accept(receipt,pending);
 }

 return <>
  <div className="page-heading">
   <div><h1>Project Lifecycle</h1><div className="badges">
    <span className="badge">{dirty?'草稿有未保存变更':view.draft?'草稿已保存':'草稿'}</span>
    {view.active?<span className="badge">{!dirty&&view.active.matchesSavedDraft?'当前草稿已启用':'已有启用版本'}</span>:null}
   </div></div>
   <div className="button-row">
    <button type="button" disabled={busy||!!pending||!withinLimit} onClick={()=>void run(validate)}>校验 YAML</button>
    <button type="button" className="primary" disabled={locked||!withinLimit||(!dirty&&!!view.draft?.yaml)}
     onClick={()=>void run(save)}>保存草稿</button>
   </div>
  </div>
  {message?<div className={`notice${message.error?' error':''}`} role={message.error?'alert':'status'}>{message.text}</div>:null}
  {!canEdit?<div className="notice">当前身份仅可浏览和校验草稿。</div>:null}
  {pending?<div className="notice warning">待核对原请求 <code>{pending.requestId}</code>。
   <button type="button" disabled={busy} onClick={()=>void run(reconcile)}>核对原请求</button>
  </div>:null}
  {conflict?<div className="notice warning">服务端草稿已变化。当前 YAML 已保留。
   <button type="button" disabled={busy} onClick={()=>{
    if(!dirty||window.confirm('重新读取会替换当前未保存的 YAML，是否继续？')){
     void run(async()=>useReadback(await inspectFeedbackDraft(session)));
    }
   }}>重新读取草稿</button>
  </div>:null}
  <FeedbackGraph selected={selected} onSelect={stage=>setSelected(previous=>previous?.id===stage.id?null:stage)}>
   {selected?<div className="panel properties" id="feedback-node-configuration">
    <h2>{selected.label}配置</h2>
    <label htmlFor="feedback-binding">{bindingLabels[selected.field]}</label>
    <input id="feedback-binding" value={typeof fields?.[selected.field]==='string'?String(fields[selected.field]):''}
     autoComplete="off" spellCheck={false} placeholder="binding:provider/reference"
     disabled={locked||!fields} onChange={event=>editField(selected.field,event.target.value)}/>
    {selected.id==='review'?<p className="muted">复核窗口固定为 60 分钟。</p>:null}
   </div>:<p className="graph-hint">选择节点以查看和修改绑定引用。</p>}
  </FeedbackGraph>
  <section className="panel source-panel" aria-labelledby="feedback-yaml-heading">
   <div className="section-heading"><h2 id="feedback-yaml-heading">YAML 源码</h2><span className="muted">YAML 1.2</span></div>
   <label className="sr-only" htmlFor="feedback-lifecycle-yaml">Feedback Project Lifecycle YAML</label>
   <textarea id="feedback-lifecycle-yaml" className="code-editor" value={text} readOnly={locked} spellCheck={false}
    onChange={event=>change(event.target.value)}/>
   {!withinLimit?<p className="field-error" role="alert">YAML 超过 16 KiB。</p>:null}
   {syntaxError?<p className="field-error" role="alert">{syntaxError}</p>:null}
   <p className="muted">使用受保护的绑定引用。草稿启用由 Codex Runtime Expert 完成。</p>
  </section>
 </>;
}

export function Editor(props:EditorProps){
 const {session,onDirty,onAuthLost}=props;
 const [mode,setMode]=useState<'feedback'|'base'|null>(null);
 const [view,setView]=useState<FeedbackDraftView|null>(null);
 const dirty=useRef(false);
 const [problem,setProblem]=useState('');
 const [checking,setChecking]=useState(false);
 const checked=useRef(false);
 function trackDirty(next:boolean){
  dirty.current=next;
  onDirty(next);
 }
 async function connectFeedback(signal?:AbortSignal,open=false){
  setChecking(true);
  try{
   const next=await inspectFeedbackDraft(session,signal);
   if(signal?.aborted)return;
   setView(next);
   setProblem('');
   const pending=loadPending(session);
   if(open&&pending){
    setProblem('请先核对原请求。');
    return;
   }
   if(open&&dirty.current&&!window.confirm('切换编辑器会丢弃未保存的 YAML，是否继续？'))return;
   const initialMode=pending?(pending.operation===FEEDBACK_DRAFT_SAVE?'feedback':'base'):next.draft?'feedback':'base';
   setMode(current=>open?'feedback':current??initialMode);
  }catch(error){
   if(signal?.aborted)return;
   if(error instanceof ApiError&&error.status===401)onAuthLost();
   if(!(error instanceof ApiError&&['DASHBOARD_OPERATION','LIMITED_PREVIEW','UNKNOWN_OPERATION'].includes(error.code))){
    setProblem(error instanceof Error?error.message:String(error));
   }
   setMode(current=>current??'base');
  }finally{
   if(!signal?.aborted)setChecking(false);
  }
 }
 useEffect(()=>{
  if(checked.current)return;
  const controller=new AbortController();
  void connectFeedback(controller.signal).then(()=>{if(!controller.signal.aborted)checked.current=true;});
  return()=>controller.abort();
 },[session]);
 function switchMode(){
  if(loadPending(session)){
   setProblem('请先核对原请求。');
   return;
  }
  setProblem('');
  if(mode==='feedback'){
   if(!dirty.current||window.confirm('切换编辑器会丢弃未保存的 YAML，是否继续？'))setMode('base');
  }else void connectFeedback(undefined,true);
 }
 if(mode===null)return <div className="panel" role="status">正在读取项目配置…</div>;
 const switchButton=view||problem?<div className="button-row">
  <button type="button" disabled={checking} onClick={switchMode}>
   {mode==='feedback'?'编辑 Base 定义':view?'编辑反馈流程配置':'重试读取反馈流程配置'}
  </button>
 </div>:null;
 return <>
  {problem?<div className="notice warning" role="status">{problem}</div>:null}
  {mode==='feedback'&&view?<FeedbackEditor {...props} onDirty={trackDirty} initialView={view}/>:
   <>{switchButton}<BaseEditor {...props} onDirty={trackDirty}/></>}
  {mode==='feedback'?switchButton:null}
 </>;
}
