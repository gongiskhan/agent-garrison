"use client";
import { useEffect, useState } from "react";
import { useAppShell } from "@/components/chrome/AppShell";
import type { FittingSharingInfo } from "@/lib/fitting-sharing";
import type { SharedRuntime } from "@/lib/types";

const LABELS: Record<SharedRuntime, string> = { "claude-code": "Claude Code", codex: "Codex", gemini: "Gemini" };
export function SharingSection({ fittingId }: { fittingId: string }) {
  const { composition, refreshAll } = useAppShell();
  const [info, setInfo] = useState<FittingSharingInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = Object.values(composition?.selections ?? {}).flat().find(item => item?.id === fittingId);
  const compositionId = composition?.id;
  const selectionKey = JSON.stringify(selection?.shared ?? []);
  useEffect(() => {
    if (!compositionId) return;
    const controller = new AbortController();
    fetch(`/api/fittings/${encodeURIComponent(fittingId)}/sharing?composition=${encodeURIComponent(compositionId)}`, { signal: controller.signal })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error || "Could not read sharing"); return body; })
      .then(body => { setInfo(body); setError(null); })
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason.message || reason)); });
    return () => controller.abort();
  }, [fittingId, compositionId, selectionKey]);
  async function toggle(runtime: SharedRuntime, checked: boolean) {
    if (!info || !composition) return;
    const faculty = Object.entries(composition.selections).find(([, items]) => items?.some(item => item.id === fittingId))?.[0];
    const shared = checked ? [...info.shared, runtime] : info.shared.filter(item => item !== runtime);
    const previous = info;
    setInfo({ ...info, shared }); setBusy(true); setError(null);
    try {
      const response = await fetch("/api/muster/standing/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ composition: composition.id, faculty, fittingId, shared }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "Could not change sharing");
      setInfo({ ...info, shared }); await refreshAll();
    } catch (reason) { setInfo(previous); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <section aria-label="Sharing" data-testid={`fitting-sharing-${fittingId}`} style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--rule)" }}>
    <h3 style={{ fontSize: 14, margin: "0 0 12px" }}>Sharing</h3>
    {!info && !error ? <p style={{ color: "var(--mute)", fontSize: 12 }}>Reading sharing…</p> : null}
    {info?.runtimes.map(runtime => <div key={runtime} style={{ marginBottom: 10 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13 }}>
        <input type="checkbox" role="switch" checked={info.shared.includes(runtime)} disabled={busy || !info.available[runtime]} onChange={event => void toggle(runtime, event.target.checked)} />
        Also available in your own {LABELS[runtime]} sessions
      </label>
      {!info.available[runtime] ? <p style={{ margin: "4px 0 0 24px", color: "var(--mute)", fontSize: 12 }}>Nothing to share for {LABELS[runtime]}</p> : null}
    </div>)}
    <p style={{ fontSize: 12, lineHeight: 1.6, color: "var(--mute)", maxWidth: 680 }}>
      Garrison keeps its skills, hooks and MCP servers in its own home, so your terminal sessions never pick them up. Sharing installs this fitting into your own config too (~/.claude, ~/.codex, ~/.gemini), the same as if you had installed it yourself, and removes it again when you switch this off or uninstall Garrison.
    </p>
    {error ? <p role="alert" style={{ color: "var(--alarm)", fontSize: 12 }}>{error}</p> : null}
  </section>;
}
