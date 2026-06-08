"use client";

import type { QuartersCategory } from "./quartersTypes";

// Logs / Sessions are read-only records. Collection is Garrison-side; the
// surfaces are provided by the Observability / Session-View own-port fittings
// (Monitor pattern) when stationed. This panel states that contract; live
// tailing rides with those fittings' embedded views in the sidebar's Views group.
export function ReadOnlyNotePanel({ cat }: { cat: QuartersCategory }) {
  const faculty = cat.slug === "logs" ? "Observability" : "Session Viewer";
  return (
    <main>
      <div className="crumbs"><b>Quarters</b> · {cat.label}</div>
      <div className="page">
        <div className="head">
          <h1>{cat.label}</h1>
          <p className="ld">{cat.blurb}</p>
          <span className="pill idle" style={{ fontSize: 10.5 }}>read-only</span>
        </div>
        <section
          style={{ border: "1px solid var(--rule)", background: "white", padding: 20 }}
          data-testid={`readonly-${cat.slug}`}
        >
          <p style={{ margin: 0, color: "var(--mute)", fontSize: 13 }}>
            {cat.label} are surfaced read-only by the <b>{faculty}</b> faculty. Station an{" "}
            {faculty} fitting to see its live view under the sidebar&apos;s Views group — Garrison
            never writes these records.
          </p>
        </section>
      </div>
    </main>
  );
}
