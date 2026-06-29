"use client";

import Link from "next/link";
import type { ResolvedPromotedFitting } from "@/lib/promoted-catalog";
import { SetupInstructionsEditor } from "./SetupInstructionsEditor";

// Detail view for a promoted Fitting — a Claude Code primitive presented as a
// first-class Fitting. Shows its plain-language + technical description, its
// explicit contract, the editable Setup Instructions, and (as internal,
// technical metadata only) what it is made of. The primitive type is never the
// headline; it appears only in the small "Under the hood" footnote.
export function PromotedFittingDetail({ fitting }: { fitting: ResolvedPromotedFitting }) {
  return (
    <main style={{ padding: "32px 36px", maxWidth: 880 }} data-testid={`promoted-detail-${fitting.id}`}>
      <div className="crumbs" style={{ marginBottom: 16 }}>
        <Link href="/compose">Compose</Link>
        {" · "}
        <span>{fitting.facultyName}</span>
        {" · "}
        <b>{fitting.title}</b>
      </div>

      <header style={{ marginBottom: 22 }}>
        <div
          className="font-mono"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "var(--brass)",
            marginBottom: 6,
            display: "flex",
            gap: 10,
            alignItems: "center"
          }}
        >
          <span>
            {fitting.facultyName} faculty · {fitting.tier === "agent" ? "Agent" : "Dev"}
          </span>
          <span
            data-testid="promoted-detail-presence"
            style={{ color: fitting.present ? "var(--sage)" : "var(--mute)" }}
          >
            {fitting.present ? "installed" : "available"}
          </span>
        </div>
        <h1
          className="font-display"
          style={{ fontWeight: 600, fontSize: 30, letterSpacing: "-0.012em", lineHeight: 1.1, margin: "0 0 10px" }}
        >
          {fitting.title}
        </h1>
        <p style={{ fontSize: 14.5, lineHeight: 1.6, color: "var(--ink)", margin: "0 0 8px", maxWidth: 660 }}>
          {fitting.descriptionPlain}
        </p>
        <p
          className="font-mono"
          style={{ fontSize: 12, lineHeight: 1.55, color: "var(--mute)", margin: 0, maxWidth: 660 }}
        >
          {fitting.descriptionTechnical}
        </p>
      </header>

      <Contract title="Provides" items={fitting.provides} empty="Nothing it exposes to other Fittings." />
      <Contract title="Consumes" items={fitting.consumes} empty="No dependencies — additive." />

      <SetupInstructionsEditor fittingId={fitting.id} initialSteps={fitting.setup} />

      {fitting.notes ? (
        <section
          style={{
            marginTop: 26,
            padding: "12px 14px",
            background: "var(--paper-2)",
            border: "1px dashed var(--rule-2)",
            fontSize: 12.5,
            color: "var(--mute)",
            lineHeight: 1.55
          }}
        >
          <span className="font-mono" style={{ color: "var(--brass)", marginRight: 6 }}>
            note ·
          </span>
          {fitting.notes}
        </section>
      ) : null}

      {/* Internal/technical only — what this Fitting is made of underneath. The
          primitive type lives here and nowhere user-facing. */}
      <section style={{ marginTop: 22 }}>
        <div
          className="font-mono"
          style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--mute)", marginBottom: 6 }}
        >
          Under the hood
        </div>
        <div className="font-mono" style={{ fontSize: 11.5, color: "var(--mute)", lineHeight: 1.7 }}>
          {fitting.members.map((m, i) => (
            <span key={`${m.surface}:${m.name}:${i}`} style={{ marginRight: 12 }}>
              {m.name}
              <span style={{ color: m.present ? "var(--sage)" : "var(--rule-2)" }}> {m.present ? "●" : "○"}</span>
            </span>
          ))}
        </div>
      </section>
    </main>
  );
}

function Contract({
  title,
  items,
  empty
}: {
  title: string;
  items: { kind: string; name: string; cardinality?: string }[];
  empty: string;
}) {
  return (
    <section style={{ marginTop: 18 }} data-testid={`promoted-contract-${title.toLowerCase()}`}>
      <div
        className="font-mono"
        style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--brass)", marginBottom: 6 }}
      >
        {title}
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--mute)" }}>{empty}</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexWrap: "wrap", gap: 8 }}>
          {items.map((c, i) => (
            <li
              key={i}
              className="font-mono"
              style={{
                fontSize: 11.5,
                border: "1px solid var(--rule)",
                background: "white",
                padding: "4px 9px",
                color: "var(--ink)"
              }}
            >
              <span style={{ color: "var(--mute)" }}>{c.kind}:</span> {c.name}
              {c.cardinality ? <span style={{ color: "var(--mute)" }}> · {c.cardinality}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
