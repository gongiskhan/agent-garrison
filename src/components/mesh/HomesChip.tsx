"use client";
import { useState } from "react";
import type { HomeLeakReport } from "@/lib/home-leaks";
import type { MeshNodeRow } from "@/lib/mesh/node-row";
import { nodeHealth } from "@/lib/mesh/node-row";
export function HomesChip({ node }: { node: MeshNodeRow }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<HomeLeakReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = node.isSelf ? "/api/install" : `/api/mesh/nodes/${encodeURIComponent(node.id)}/install`;
  const homes = nodeHealth(node).homes;
  async function show() {
    setOpen(true); setError(null);
    try { const response = await fetch(`${base}/leaks`); const body = await response.json(); if (!response.ok) throw new Error(body.error || "Could not read home leaks"); setReport(body); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function quarantine() {
    setBusy(true); setError(null);
    try { const response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "quarantine-leaks" }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "Could not quarantine leaks"); setReport(body.homes); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const count = report?.leaks.length ?? homes?.leaks;
  return <>
    {node.state === "offline" || count === undefined ? <span>Unknown</span> : <button type="button" className={`pill ${count ? "alarm" : "ok"}`} style={{ cursor: "pointer", color: count ? "var(--alarm)" : "#237244" }} onClick={() => void show()}>{count ? `Leaks: ${count}` : "Homes ok"}</button>}
    {open ? <div role="dialog" aria-modal="true" aria-label={`Homes on ${node.name}`} style={{ position: "fixed", inset: 0, background: "#0006", zIndex: 1000, display: "grid", placeItems: "center", padding: 20 }}>
      <div style={{ width: "min(620px, 100%)", maxHeight: "85vh", overflow: "auto", background: "var(--paper, white)", padding: 24, border: "1px solid var(--rule)", color: "var(--ink)" }}>
        <h2>Homes on {node.name}</h2>
        {error ? <p role="alert">{error}</p> : null}
        {!report ? <p>Checking homes…</p> : report.ok ? <p>Homes ok</p> : <ul>{report.leaks.map(leak => <li key={`${leak.runtime}:${leak.kind}:${leak.ref}`}>{leak.kind} · {leak.name} · {leak.reason}</li>)}</ul>}
        {report && !report.ok ? <button className="btn" disabled={busy} onClick={() => void quarantine()}>{busy ? "Quarantining…" : "Quarantine all"}</button> : null}
        <button className="btn" disabled={busy} onClick={() => setOpen(false)} style={{ marginLeft: 8 }}>Close</button>
      </div>
    </div> : null}
  </>;
}
