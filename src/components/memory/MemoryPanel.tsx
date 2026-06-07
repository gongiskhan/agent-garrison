"use client";

import { useCallback, useEffect, useState } from "react";
import type { ClaudeMdScope, ClaudeMdView } from "@/lib/claude-md";

export function MemoryPanel() {
  const [scope, setScope] = useState<ClaudeMdScope>("user");
  const [view, setView] = useState<ClaudeMdView | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async (s: ClaudeMdScope) => {
    setError(null);
    setConflict(false);
    setSaved(false);
    try {
      const res = await fetch(`/api/claude-md?scope=${s}`);
      const data = (await res.json()) as ClaudeMdView;
      if (!res.ok) throw new Error((data as unknown as { error?: string }).error ?? res.statusText);
      setView(data);
      setDraft(data.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load(scope);
  }, [scope, load]);

  const dirty = view !== null && draft !== view.content;

  const save = useCallback(async () => {
    if (!view) return;
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      const res = await fetch("/api/claude-md", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, content: draft, baselineSha: view.sha })
      });
      const data = await res.json();
      if (res.status === 409) {
        setConflict(true);
        return;
      }
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setView(data.view as ClaudeMdView);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [scope, draft, view]);

  return (
    <main>
      <div className="crumbs"><b>Memory</b></div>
      <div className="page">
        <div className="head">
          <h1>Memory · CLAUDE.md</h1>
          <p className="ld">
            Garrison edits the durable, hand-authored <code>CLAUDE.md</code> guidance files directly —
            user-global (<code>~/.claude/CLAUDE.md</code>) and the current project. This is the canonical
            store for behavioral guidance. The episodic memory-compiler (a separate knowledge store) is
            unaffected and keeps running independently.
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {(["user", "project"] as ClaudeMdScope[]).map((s) => (
            <button
              key={s}
              className={s === scope ? "btn small primary" : "btn small ghost"}
              data-testid={`scope-${s}`}
              onClick={() => setScope(s)}
            >
              {s === "user" ? "User (~/.claude)" : "Project"}
            </button>
          ))}
        </div>

        {error ? (
          <div className="banner alarm"><span className="glyph">!</span><div><h5>Error</h5><p>{error}</p></div></div>
        ) : null}

        {conflict ? (
          <div className="banner alarm" data-testid="conflict-banner">
            <span className="glyph">!</span>
            <div>
              <h5>Changed outside Garrison — not overwritten</h5>
              <p>This CLAUDE.md was edited elsewhere since you opened it. Your edit was NOT saved to avoid
              clobbering. Reload to see the current content, then re-apply your change.</p>
            </div>
          </div>
        ) : null}

        <div style={{ border: "1px solid var(--rule)", background: "white" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid var(--rule)" }}>
            <code style={{ fontSize: 11.5, color: "var(--mute)" }}>{view?.path ?? "…"}</code>
            <span style={{ fontSize: 11, color: "var(--mute)" }}>{view?.exists ? "" : "(does not exist — saving creates it)"}</span>
          </div>
          <textarea
            className="text"
            data-testid="claude-md-editor"
            style={{ fontFamily: "var(--font-mono), monospace", fontSize: 12.5, width: "100%", minHeight: 420, border: "none", padding: 16 }}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
          />
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
          <button className="btn primary" data-testid="claude-md-save" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn small ghost" disabled={busy} onClick={() => void load(scope)}>Reload</button>
          {saved ? <span data-testid="claude-md-saved" style={{ color: "var(--sage)", fontSize: 12.5 }}>Saved.</span> : null}
          {dirty ? <span style={{ color: "var(--mute)", fontSize: 12 }}>unsaved changes</span> : null}
        </div>
      </div>
    </main>
  );
}
