"use client";

import { useCallback, useEffect, useState } from "react";
import type { StateModel, PrimitiveRecord } from "@/lib/primitive-state";
import { StateBadge } from "./StateBadge";
import { WRITER_LABEL, type QuartersCategory } from "./quartersTypes";

// One parameterized panel for every package-surface category (Skills/Hooks/MCPs/
// Plugins/Scripts). Lists ALL primitives with their state and a promote/park
// action. Refetches on action completion (no watcher) — the structural answer to
// the immediate-save echo storm for the package surface.
export function PrimitiveListPanel({ cat }: { cat: QuartersCategory }) {
  const [model, setModel] = useState<StateModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/quarters");
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error ?? res.statusText);
      setModel(data as StateModel);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (rec: PrimitiveRecord) => {
      const body =
        rec.state === "loose"
          ? { action: "promote", id: rec.id }
          : { action: "park", fittingId: rec.fittingId ?? rec.name };
      setBusy(rec.id);
      setError(null);
      try {
        const res = await fetch("/api/quarters", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok || data?.ok === false) {
          throw new Error(data?.error ?? data?.code ?? res.statusText);
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [load]
  );

  const surfaces = cat.surfaces ?? [];
  const records = surfaces.flatMap((s) => model?.bySurface[s] ?? []);
  const actionable = cat.writer === "apm" || cat.writer === "split"; // hooks/mcp manage differently

  return (
    <main>
      <div className="crumbs"><b>Quarters</b> · {cat.label}</div>
      <div className="page">
        <div className="head">
          <h1>{cat.label}</h1>
          <p className="ld">{cat.blurb}</p>
          <span className="pill idle" style={{ fontSize: 10.5 }}>{WRITER_LABEL[cat.writer]}</span>
        </div>

        {error ? (
          <div className="banner alarm" data-testid="primitive-error">
            <span className="glyph">!</span>
            <div><h5>Action failed</h5><p>{error}</p></div>
          </div>
        ) : null}

        <section style={{ border: "1px solid var(--rule)", background: "white" }} data-testid={`primitives-${cat.slug}`}>
          {!model ? (
            <div style={{ padding: 20, color: "var(--mute)", fontSize: 13 }} className="ld">Loading…</div>
          ) : records.length === 0 ? (
            <div style={{ padding: 20, color: "var(--mute)", fontSize: 13, textAlign: "center" }}>
              No {cat.label.toLowerCase()} found in ~/.claude.
            </div>
          ) : (
            records.map((rec) => (
              <div
                key={rec.id}
                data-testid={`primitive-${rec.id}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto auto",
                  gap: 12,
                  alignItems: "center",
                  padding: "11px 18px",
                  borderBottom: "1px solid var(--rule)"
                }}
              >
                <div>
                  <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{rec.name}</span>
                  {rec.fittingId ? (
                    <code style={{ fontSize: 11, color: "var(--mute)", marginLeft: 8 }}>{rec.fittingId}</code>
                  ) : null}
                </div>
                <StateBadge state={rec.state} drifted={rec.driftedFromLock} />
                {actionable && (rec.state === "loose" || rec.state === "owned") ? (
                  <button
                    className="btn small"
                    data-testid={`action-${rec.id}`}
                    disabled={busy === rec.id}
                    onClick={() => void act(rec)}
                  >
                    {busy === rec.id ? "…" : rec.state === "loose" ? "Promote" : "Park"}
                  </button>
                ) : (
                  <span style={{ fontSize: 11, color: "var(--mute)" }}>
                    {cat.slug === "hooks" ? "manage via fitting" : ""}
                  </span>
                )}
              </div>
            ))
          )}
        </section>
      </div>
    </main>
  );
}
