import React, { useEffect, useRef, useState } from "react";

type Account = {provider:string; account:string; plan?:string; status:string; checkedAt:string|null; detail?:string; dashboardUrl?:string; windows:{label:string;usedPercent:number;resetsAt:string|null}[]};
const LABEL:Record<string,string> = {claude:"Claude Code",codex:"Codex",cursor:"Cursor"};

/** Lazy, owner-routed account reads. Opening usage never blocks shell input. */
export function SessionUsage({base, runtime, node, disconnected = false}: {base:string;runtime?:string;node:string;disconnected?:boolean}) {
  const [open,setOpen] = useState(false);
  const [accounts,setAccounts] = useState<Account[]>([]);
  const [busy,setBusy] = useState(false);
  const [failed,setFailed] = useState(false);
  const box = useRef<HTMLDetailsElement>(null);
  const providers = runtime && LABEL[runtime] ? runtime : "claude,codex,cursor";
  useEffect(() => {
    setAccounts([]); setFailed(false);
    if (!open || disconnected) { setBusy(false); return; }
    let alive = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 18_000);
    setBusy(true);
    void Promise.all(providers.split(",").map(async provider => {
      try {
        const r = await fetch(`${base}/session-usage/${provider}`, {signal:controller.signal,cache:"no-store"});
        const body = r.ok ? await r.json() : null;
        if (!Array.isArray(body?.accounts)) throw new Error("Unavailable");
        return body.accounts as Account[];
      } catch { return [{provider,account:"Machine login",status:"unavailable",windows:[],checkedAt:null,detail:"Could not read account usage on this machine."}]; }
    })).then(results => {
      if (!alive || controller.signal.aborted) return;
      setAccounts(results.flat()); setBusy(false);
    }).finally(() => {window.clearTimeout(timer); if (alive && controller.signal.aborted) {setBusy(false); setFailed(true);}});
    return () => {alive = false;window.clearTimeout(timer);controller.abort();};
  }, [base,providers,open,disconnected]);
  useEffect(() => {
    if (!open) return;
    const close = (e:PointerEvent|KeyboardEvent) => {
      if ((e instanceof KeyboardEvent && e.key === "Escape") || (e instanceof PointerEvent && e.target instanceof Node && !box.current?.contains(e.target))) {
        if (box.current) box.current.open = false;
      }
    };
    document.addEventListener("keydown",close);document.addEventListener("pointerdown",close);
    return () => {document.removeEventListener("keydown",close);document.removeEventListener("pointerdown",close);};
  },[open]);
  return <details className="wc-usage" ref={box} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary aria-label="Account usage">Usage</summary>
    {open && <div className="wc-usage-panel" role="region" aria-label="Account usage">
      <button type="button" className="wc-usage-close" aria-label="Close account usage" onClick={()=>{if(box.current) box.current.open=false; setOpen(false);}}>Close</button>
      <strong>Account usage</strong><span className="wc-usage-scope">{node} · shared across sessions</span>
      {disconnected ? <p>This machine is disconnected. Usage will return when it reconnects.</p> : busy ? <p role="status">Checking accounts…</p> : failed ? <p>Account usage is temporarily unavailable.</p> : accounts.map((account,i)=><section key={`${account.provider}:${i}`}>
        <strong>{LABEL[account.provider] || account.provider}{account.plan ? ` · ${account.plan}` : ""}</strong>
        <span className="wc-usage-scope">{account.account}</span>
        {account.status === "stale" && <span className="wc-usage-stale">Last known usage</span>}
        {(account.windows || []).map((w,j)=><div className="wc-usage-window" key={j}>
          <span>{w.label}</span><b>{Math.round(w.usedPercent * 10) / 10}% used</b>
          <progress max={100} value={w.usedPercent} aria-label={`${w.label} used`} />
          {w.resetsAt && <small>Resets {new Date(w.resetsAt).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</small>}
        </div>)}
        {account.detail && <p>{account.detail}</p>}
        {account.dashboardUrl === "https://cursor.com/dashboard?tab=usage" && <a href={account.dashboardUrl} target="_blank" rel="noreferrer">Open Cursor usage</a>}
        {account.checkedAt && <small>Checked {new Date(account.checkedAt).toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"})}</small>}
      </section>)}
    </div>}
  </details>;
}
