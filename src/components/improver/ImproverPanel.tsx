"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import styles from "./ImproverPanel.module.css";

type Proposal = { id:string;rev:number;node:string;track:string;title:string;reason:string;change:string;acceptance:string;status:string;error?:string;rejectionReason?:string;taskNeedsAttention?:boolean;
  action:{type:string;content?:string};evidence:Array<{id?:string;node:string;title?:string;kind?:string;ref:string}>;receipt?:{taskId?:string;link?:string;verifiedAt?:string;title?:string;verification?:{summary?:string;evidenceRefs?:unknown[]}}; };
type Run = {id:string;node:string;day:string;mode:string;status:string;stage:string;summary?:string;error?:string;operationalErrors?:string[];inputErrors?:Array<{kind:string;error:string}>;sourceCount?:number;startedAt:string;coverage?:Array<{kind:string;reviewed:number;available:boolean}>;steps?:Array<{node:string;status:string;summary?:string;error?:string}>};
type Track={mode:string;kept:number;rejected:number;reverted:number;failed:number;streak:number};
type Overview={questions:Array<{id:string;node:string;questions:Array<{question:string;options?:Array<string|{label:string}>}>}>;node:string;proposals:Proposal[];runs:Run[];tracks:Record<string,{title:string;description:string}>;settings:{tracks:Record<string,Track>};promotionThreshold:number;notices:Array<{id:string;title:string;text:string;at:string;deliveryError?:string}>};
const pending = new Set(["pending","failed"]);
const reviewing = new Set(["in-progress","verification","applying","reverting"]);
const statusLabel:Record<string,string>={pending:"Decision needed",failed:"Needs attention","in-progress":"Work in progress",verification:"Verify the outcome",kept:"Kept",rejected:"Rejected",reverted:"Reverted",history:"Previous decision",applying:"Applying",reverting:"Reverting"};

export function ImproverPanel() {
  const [data,setData]=useState<Overview|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState<string|null>(null);
  const [tab,setTab]=useState("decisions"),[filter,setFilter]=useState("all"),[showHistory,setShowHistory]=useState(false);
  const [day,setDay]=useState(()=>new Date(Date.now()-86400_000).toISOString().slice(0,10));
  async function load(){const r=await fetch("/api/improver",{cache:"no-store"});const body=await r.json();if(!r.ok)throw new Error(body.error);setData(body);}
  useEffect(()=>{let alive=true;const refresh=()=>{if(alive)void load().catch((e)=>{if(alive)setError(e.message);});};refresh();const timer=setInterval(refresh,10_000);return()=>{alive=false;clearInterval(timer);};},[]);
  async function act(key:string,body:Record<string,unknown>){setBusy(key);setError(null);try{const r=await fetch("/api/improver",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw new Error(result.error);await load();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(null);}}
  const decisions=data?.proposals.filter((p)=>pending.has(p.status))??[];
  const progress=data?.proposals.filter((p)=>reviewing.has(p.status))??[];
  const filtered=data?.proposals.filter((p)=>(showHistory||pending.has(p.status)||reviewing.has(p.status))&&(filter==="all"||p.track===filter))??[];
  return <main className={styles.page}>
    <div className={styles.eyebrow}>Garrison · Continuous improvement</div>
    <header className={styles.header}><div><h1>Improver</h1><p>Learn from the work. Make a concrete change. Keep what helps.</p></div>
      <div className={styles.runControls}><label>Review day<input aria-label="Review day" type="date" value={day} onChange={(e)=>setDay(e.target.value)}/></label>
        <button disabled={!!busy} onClick={()=>void act("review",{action:"review",day,retry:true})}>Review this node</button>
        <button className={styles.primary} disabled={!!busy} onClick={()=>void act("nightly",{action:"nightly",day,retry:true})}>Run Nightly Sync</button></div></header>
    {error&&<div role="alert" className={styles.error}>{error}<button onClick={()=>setError(null)} aria-label="Dismiss error">×</button></div>}
    {!data?<p role="status">Loading improvement history…</p>:<>
      <div className={styles.stats}><div><strong>{decisions.length}</strong><span>decisions to make</span></div><div><strong>{progress.length}</strong><span>changes to follow</span></div><div><strong>{data.proposals.filter((p)=>p.status==="kept").length}</strong><span>improvements kept</span></div>
        <div><strong>{data.runs.filter((r)=>r.status==="running").length}</strong><span>reviews running</span></div></div>
      <nav className={styles.tabs} aria-label="Improver sections">{[["decisions","Decisions"],["activity","Daily reviews"],["autonomy","Autonomy"]].map(([id,title])=><button key={id} aria-current={tab===id?"page":undefined} onClick={()=>setTab(id)}>{title}</button>)}</nav>
      {tab==="decisions"&&<>{data.questions?.map((p)=><FeedbackQuestion key={p.id} pending={p} busy={!!busy} act={act}/>)}<div className={styles.filters}><label>Track<select value={filter} onChange={(e)=>setFilter(e.target.value)}><option value="all">All tracks</option>{Object.entries(data.tracks).map(([id,t])=><option key={id} value={id}>{t.title}</option>)}</select></label><label className={styles.check}><input type="checkbox" checked={showHistory} onChange={(e)=>setShowHistory(e.target.checked)}/>Show past decisions</label></div>
        {filtered.length===0?<div className={styles.empty}><h2>No decisions waiting</h2><p>Daily reviews look for repeated friction, explicit corrections and useful lessons. New findings appear here with their evidence.</p></div>:
          <div className={styles.proposals}>{filtered.map((p)=><ProposalCard key={p.id} proposal={p} track={data.tracks[p.track]?.title??p.track} busy={!!busy} act={act}/>)}</div>}</>}
      {tab==="activity"&&<section><p className={styles.explain}>Nightly Sync checks the existing Git and vault sync services, processes Zeca, and reviews work on each node. Evidence stays on its owner; decisions are shared across the mesh.</p>
        {data.runs.length===0?<p>No core reviews have run yet.</p>:data.runs.map((run)=><article className={styles.run} key={run.id}><div className={styles.row}><h2>{run.mode==="nightly"?"Nightly Sync":run.node}</h2><span className={styles.badge}>{run.status}</span></div><p>{run.day} · {run.stage}{run.sourceCount!==undefined?` · ${run.sourceCount} evidence sources`:""}</p><p>{run.summary||run.error||"Review is running. You can leave this page."}</p>
          {run.operationalErrors?.map((e)=><p className={styles.error} key={e}>{e}</p>)}{run.inputErrors?.map((e)=><p className={styles.error} key={e.kind}>{e.kind}: {e.error}</p>)}
          {run.coverage&&<div className={styles.coverage}>{run.coverage.map((c)=><span key={c.kind}>{c.kind}: {c.available?`${c.reviewed} reviewed`:"unavailable"}</span>)}</div>}
          {run.steps&&<ul>{run.steps.map((step)=><li key={step.node}><b>{step.node}</b> · {step.status} — {step.summary||step.error}</li>)}</ul>}
          {["failed","partial"].includes(run.status)&&<button disabled={!!busy} onClick={()=>void act(run.id,{action:run.mode==="nightly"?"nightly":"review",day:run.day,retry:true,node:run.node,nightly:run.mode==="nightly-review"})}>Retry review</button>}</article>)}
        <h2>Recent notices</h2>{data.notices.slice(0,10).map((n)=><div key={n.id} className={styles.notice}><b>{n.title}</b><p>{n.text}</p>{n.deliveryError&&<small>Push delivery failed: {n.deliveryError}. The notice remains here.</small>}</div>)}</section>}
      {tab==="autonomy"&&<section><p className={styles.explain}>You choose which tracks may act automatically. The Improver recommends promotion after {data.promotionThreshold} consecutive verified changes you kept. A rejection, failed apply or revert returns the track to review.</p>
        <div className={styles.trackGrid}>{Object.entries(data.tracks).map(([id,t])=>{const state=data.settings.tracks[id];return <article className={styles.track} key={id}><h2>{t.title}</h2><p>{t.description}</p><label>Future improvements<select aria-label={`${t.title} autonomy`} value={state.mode} disabled={!!busy} onChange={(e)=>void act(id,{action:"autonomy",track:id,mode:e.target.value})}><option value="review">Review each change</option><option value="automatic">Apply automatically</option></select></label><p className={styles.score}>{state.kept} kept · {state.rejected} rejected · {state.reverted} reverted · {state.failed} failed</p><p>{state.streak>=data.promotionThreshold&&state.mode==="review"?"Ready to consider automatic improvements.":`${state.streak}/${data.promotionThreshold} consecutive kept outcomes`}</p></article>;})}</div></section>}
    </>}
  </main>;
}
function ProposalCard({proposal:p,track,busy,act}:{proposal:Proposal;track:string;busy:boolean;act:(key:string,body:Record<string,unknown>)=>Promise<void>}){
  const [note,setNote]=useState("");
  const decide=(decision:string)=>void act(p.id,{action:"decide",id:p.id,decision,reason:note,rev:p.rev});
  return <article className={styles.proposal} id={p.id}><div className={styles.row}><span className={styles.eyebrow}>{track} · {p.node}</span><span className={styles.badge}>{statusLabel[p.status]??p.status}</span></div><h2>{p.title}</h2><p>{p.reason}</p>
    <details><summary>Proposed change and evidence</summary><div className={styles.change}><h3>{p.action.type==="memory"?"Memory to save":"Change to implement"}</h3><p>{p.action.content||p.change}</p><h3>How to verify it</h3><p>{p.acceptance}</p></div><ul className={styles.sources}>{p.evidence.map((e,i)=><li key={e.id??i}><b>{e.title||e.kind||"Source"}</b><span>{e.node}</span>{e.ref?.startsWith("/talk/")?<Link href={`/mesh/talk/${encodeURIComponent(e.node)}/${encodeURIComponent(e.ref.slice(6))}`}>Open conversation</Link>:<code>{e.ref}</code>}</li>)}</ul></details>
    {p.error&&<p className={styles.error}>{p.error}</p>}{p.rejectionReason&&<p>Correction: {p.rejectionReason}</p>}
    {p.receipt?.verification?.summary&&<div className={styles.change}><h3>Implementation outcome</h3><p>{p.receipt.verification.summary}</p></div>}
    {p.receipt?.taskId&&<p><Link href={`/mesh/talk/${encodeURIComponent(p.node)}/${encodeURIComponent(p.receipt.taskId)}`}>{p.taskNeedsAttention?"Task needs attention":"Open implementation and evidence"}</Link></p>}
    {["pending","failed","verification","kept"].includes(p.status)&&<><label className={styles.note}>Notes or correction<textarea value={note} onChange={(e)=>setNote(e.target.value)} placeholder="Add context, a correction, or what worked" rows={2}/></label><div className={styles.actions}>
      {p.status==="pending"&&<><button className={styles.primary} disabled={busy} onClick={()=>decide("approve")}>{p.action.type==="memory"?"Save memory":"Start improvement"}</button><button disabled={busy} onClick={()=>decide("reject")}>Reject</button></>}
      {p.status==="failed"&&<button disabled={busy} onClick={()=>decide("retry")}>Retry safely</button>}
      {p.status==="verification"&&<button className={styles.primary} disabled={busy} onClick={()=>decide("keep")}>Works well · keep it</button>}
      {["verification","kept"].includes(p.status)&&<button disabled={busy} onClick={()=>decide("revert")}>Revert</button>}
    </div></>}
  </article>;
}

function FeedbackQuestion({pending:p,busy,act}:{pending:Overview["questions"][number];busy:boolean;act:(key:string,body:Record<string,unknown>)=>Promise<void>}) {
  const [answer,setAnswer]=useState("");const q=p.questions[0];if(!q)return null;
  return <article className={styles.proposal}><span className={styles.eyebrow}>Feedback · {p.node}</span><h2>{q.question}</h2><div className={styles.actions}>{q.options?.map((o,i)=>{const label=typeof o==="string"?o:o.label;return <button key={i} disabled={busy} onClick={()=>setAnswer(label)}>{label}</button>;})}</div><label className={styles.note}>Your answer<textarea rows={2} value={answer} onChange={(e)=>setAnswer(e.target.value)} placeholder="Choose an option or write your own answer"/></label><button disabled={busy||!answer.trim()} onClick={()=>void act(p.id,{action:"probe-answer",id:p.id,question:0,expectedQuestion:q.question,answer})}>Send feedback</button></article>;
}
