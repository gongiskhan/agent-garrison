"use client";

import { useCallback, useEffect, useState } from "react";
import { MarkdownEditor } from "./MarkdownEditor";
import type { PlanListItem, PlanView } from "@/lib/plans";

// Master/detail markdown editor over ~/.claude/plans. Autosave, no save button.
export function PlansPanel() {
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<PlanView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/plans");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? res.statusText);
      setPlans(data.plans as PlanListItem[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const open = useCallback(async (name: string) => {
    setSelected(name);
    setView(null);
    try {
      const res = await fetch(`/api/plans?name=${encodeURIComponent(name)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? res.statusText);
      setView(data as PlanView);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const save = useCallback(
    async (content: string) => {
      if (!selected) return;
      const res = await fetch("/api/plans", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: selected, content })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? res.statusText);
      }
    },
    [selected]
  );

  return (
    <main>
      <div className="crumbs"><b>Quarters</b> · Plans</div>
      <div className="page">
        <div className="head">
          <h1>Plans</h1>
          <p className="ld">Markdown plan files under <code>~/.claude/plans</code>. Edits autosave.</p>
        </div>

        {error ? (
          <div className="banner alarm" data-testid="plans-error">
            <span className="glyph">!</span>
            <div><h5>Plans error</h5><p>{error}</p></div>
          </div>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 280px) 1fr", gap: 16 }}>
          <section style={{ border: "1px solid var(--rule)", background: "white" }} data-testid="plans-list">
            {plans.length === 0 ? (
              <div style={{ padding: 16, color: "var(--mute)", fontSize: 12.5 }}>No plan files.</div>
            ) : (
              plans.map((p) => (
                <button
                  key={p.name}
                  data-testid={`plan-${p.name}`}
                  onClick={() => void open(p.name)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 14px",
                    border: "none",
                    borderBottom: "1px solid var(--rule)",
                    background: selected === p.name ? "var(--paper)" : "white",
                    cursor: "pointer",
                    fontSize: 12.5
                  }}
                >
                  <span className="font-mono">{p.name}</span>
                </button>
              ))
            )}
          </section>

          <section>
            {view ? (
              <MarkdownEditor value={view.content} onSave={save} testId="plan-editor" />
            ) : (
              <div style={{ padding: 20, color: "var(--mute)", fontSize: 13 }}>Select a plan to edit.</div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
