"use client";
import { useEffect, useState, useCallback } from "react";
import type { SharedRuntime } from "@/lib/types";
import type { UserQuartersState } from "@/lib/quarters-user";
export function UserHomePanel({ runtime }: { runtime: SharedRuntime }) {
  const [data, setData] = useState<UserQuartersState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/quarters/user?runtime=${runtime}`); const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not read your config");
    setData(body); setError(null);
  }, [runtime]);
  useEffect(() => { setData(null); void refresh().catch(reason => setError(reason.message)); }, [refresh]);
  async function act(action: string, id: string) {
    setBusy(id); setError(null);
    try {
      const response = await fetch("/api/quarters/user", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime, action, id }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "Could not complete the action");
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); }
  }
  return <section data-testid={`user-home-${runtime}`}>
    <div className="banner" style={{ marginBottom: 20 }}><p style={{ margin: 0 }}>Garrison does not manage this config. Everything here is yours. Items marked Shared were installed by a Garrison fitting and are removed when you unshare it or uninstall Garrison.</p></div>
    {error ? <p role="alert" className="banner alarm">{error}</p> : null}
    {!data ? <p>Reading your config…</p> : data.rows.length === 0 ? <p>No skills, hooks or MCP servers found.</p> : <ul style={{ padding: 0, listStyle: "none" }}>
      {data.rows.map(row => <li key={row.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, borderBottom: "1px solid var(--rule)", padding: "12px 0" }}>
        <span style={{ color: "var(--mute)", fontSize: 12 }}>{row.kind}</span><span style={{ flex: 1 }}>{row.name}</span>
        {row.sharedOwner ? <span className="pill idle">Shared · {row.sharedOwner}</span> : null}
        {row.leak ? <><span className="pill alarm" title={row.leak.reason}>Leak</span><button className="btn" disabled={busy !== null} onClick={() => void act("quarantine", row.id)}>Quarantine</button></> : null}
        {row.canPromote ? <button className="btn" disabled={busy !== null} onClick={() => void act("promote", row.id)}>Promote to fitting</button> : null}
      </li>)}
    </ul>}
  </section>;
}
