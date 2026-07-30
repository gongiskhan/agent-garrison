"use client";

import { useAppShell } from "@/components/chrome/AppShell";
import type { FittingViewProps } from "../registry";
import { ConfigForm } from "./ConfigForm";
import { SectionLabel, cardStyle } from "./common";

// `garrison:manage` — the baseline view every Fitting without a more specific
// shape gets: what it does, its capability wiring, its composition config
// (autosaved), its lifecycle hooks, and a jump into the full file editor.
export default function ManageView({ entry, config }: FittingViewProps) {
  const { openFittingEditor } = useAppShell();
  const meta = entry.metadata;
  const provides = meta.provides ?? [];
  const consumes = meta.consumes ?? [];

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <section style={cardStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <SectionLabel>How it works</SectionLabel>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn small ghost active:translate-y-px"
            onClick={() => openFittingEditor(entry)}
            title="Open the full file editor for this Fitting"
          >
            Edit files
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
          {meta.for_consumers?.trim() || meta.summary?.trim() || entry.summary}
        </p>
      </section>

      {(provides.length > 0 || consumes.length > 0) && (
        <section>
          <SectionLabel>Capabilities</SectionLabel>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {provides.map((p, i) => (
              <code
                key={`p-${i}`}
                className="font-mono"
                title="provides"
                style={{
                  fontSize: 11.5,
                  padding: "3px 8px",
                  border: "1px solid var(--rule)",
                  borderLeft: "2px solid var(--sage)",
                  background: "var(--surface)"
                }}
              >
                {p.kind}
                {p.name ? `:${p.name}` : ""}
              </code>
            ))}
            {consumes.map((c, i) => (
              <code
                key={`c-${i}`}
                className="font-mono"
                title="consumes"
                style={{
                  fontSize: 11.5,
                  padding: "3px 8px",
                  border: "1px solid var(--rule)",
                  borderLeft: "2px solid var(--rule-2)",
                  background: "var(--surface)",
                  color: "var(--mute)"
                }}
              >
                {c.kind}
                {"name" in c && c.name ? `:${c.name}` : ""}
              </code>
            ))}
          </div>
        </section>
      )}

      <ConfigForm entry={entry} config={config} />

      <section>
        <SectionLabel>Lifecycle hooks</SectionLabel>
        <div style={{ display: "grid", gap: 5, fontSize: 12.5 }}>
          {(meta.setup ?? []).map((step, index) => (
            <div key={index}>
              <span style={{ color: "var(--mute)" }}>setup · </span>
              <code className="font-mono" style={{ fontSize: 11.5 }}>
                {step.command}
              </code>
            </div>
          ))}
          <div>
            <span style={{ color: "var(--mute)" }}>verify · </span>
            <code className="font-mono" style={{ fontSize: 11.5 }}>
              {meta.verify.command}
            </code>
            <span style={{ color: "var(--mute)" }}> expects “{meta.verify.expect}”</span>
          </div>
        </div>
      </section>
    </div>
  );
}
