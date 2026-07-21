"use client";

import { useEffect, useState } from "react";
import type { RuntimeDegradation } from "@/lib/runtime-degradations";

interface ActiveRuntime {
  engine: string;
  isClaudeCode: boolean;
  degradations: RuntimeDegradation[];
  doc: string;
}

// Advisory notice shown ONLY when the active primary runtime is not Claude Code
// (WS2 slice S2d). It never blocks — it states which enforcement-plane behaviors
// are advisory vs enforced so the operator knows the difference at a glance.
// Silent (renders nothing) on claude-code or if the runtime can't be resolved.
export function RuntimeDegradationNotice() {
  const [active, setActive] = useState<ActiveRuntime | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/runtime/active")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive) setActive(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!active || active.isClaudeCode || active.degradations.length === 0) return null;

  return (
    <div
      data-testid="runtime-degradation-notice"
      style={{
        border: "1px solid var(--rule)",
        borderLeft: "3px solid var(--warn, #b8860b)",
        background: "var(--card, #fff)",
        padding: "10px 14px",
        margin: "8px 0",
        fontSize: 12.5,
        borderRadius: 4
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Advisory on {active.engine}
      </div>
      <div className="hint" style={{ marginBottom: 6 }}>
        On a non-Claude runtime the enforcement plane is advisory — these behave differently:
      </div>
      <ul style={{ margin: "0 0 6px 16px", padding: 0 }}>
        {active.degradations.map((d) => (
          <li key={d.behavior} style={{ marginBottom: 2 }}>
            <strong>{d.behavior}:</strong> {d.advisory}
          </li>
        ))}
      </ul>
      <div className="hint" style={{ fontSize: 11.5 }}>
        See {active.doc} for the full list.
      </div>
    </div>
  );
}
