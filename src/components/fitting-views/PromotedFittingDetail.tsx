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
    <main
      className="w-full max-w-[1080px] px-5 py-8 sm:px-8 lg:px-12 lg:py-12"
      data-testid={`promoted-detail-${fitting.id}`}
    >
      <div className="crumbs mb-6">
        <Link href="/compose">Compose</Link>
        {" · "}
        <span>{fitting.facultyName}</span>
        {" · "}
        <b>{fitting.title}</b>
      </div>

      <header className="mb-9 grid gap-3 border-l-2 border-[var(--brass)] pl-5 sm:pl-6">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--brass)]">
          <span>{fitting.facultyName} faculty · {fitting.tier === "agent" ? "Agent" : "Dev"} Fitting</span>
          <span
            data-testid="promoted-detail-presence"
            className="border px-2 py-0.5 text-[9px] tracking-[0.14em]"
            style={{
              color: fitting.present ? "var(--sage)" : "var(--mute)",
              borderColor: fitting.present ? "var(--sage)" : "var(--rule-2)",
              background: fitting.present ? "var(--sage-soft)" : "var(--surface)"
            }}
          >
            {fitting.present ? "installed" : "available"}
          </span>
        </div>
        <h1 className="font-display m-0 max-w-[18ch] text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-[0.98] tracking-[-0.035em] text-[var(--ink)]">
          {fitting.title}
        </h1>
        <p className="m-0 max-w-[66ch] text-[15px] leading-7 text-[var(--ink-mute)]">
          {fitting.descriptionPlain}
        </p>
        <p className="font-mono m-0 max-w-[78ch] text-[11.5px] leading-5 text-[var(--mute)]">
          {fitting.descriptionTechnical}
        </p>
      </header>

      <div className="grid gap-5 md:grid-cols-2">
        <Contract title="Provides" items={fitting.provides} empty="Nothing it exposes to other Fittings." />
        <Contract title="Consumes" items={fitting.consumes} empty="No dependencies — additive." />
      </div>

      <SetupInstructionsEditor fittingId={fitting.id} initialSteps={fitting.setup} />

      {fitting.notes ? (
        <section
          className="mt-8 border border-dashed border-[var(--rule-2)] border-l-[3px] border-l-[var(--brass)] bg-[var(--surface)] px-4 py-3 text-[13px] leading-6 text-[var(--mute)]"
        >
          <span className="mr-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--brass)]">
            note ·
          </span>
          {fitting.notes}
        </section>
      ) : null}

      {/* Internal/technical only — what this Fitting is made of underneath. The
          primitive type lives here and nowhere user-facing. */}
      <section className="mt-7 border-t border-[var(--rule)] pt-5">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--mute)]">
          Under the hood
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 font-mono text-[11.5px] leading-5 text-[var(--mute)]">
          {fitting.members.map((m, i) => (
            <span key={`${m.surface}:${m.name}:${i}`} className="inline-flex items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: m.present ? "var(--sage)" : "var(--rule-2)" }}
                aria-hidden
              />
              {m.name}
              <span className="visually-hidden">{m.present ? " present" : " absent"}</span>
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
    <section
      className="min-w-0 border-t-2 border-[var(--brass)] bg-[var(--surface)] px-4 py-4 sm:px-5"
      data-testid={`promoted-contract-${title.toLowerCase()}`}
    >
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--brass)]">
        {title}
      </div>
      {items.length === 0 ? (
        <div className="text-[13px] leading-6 text-[var(--mute)]">{empty}</div>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {items.map((c, i) => (
            <li
              key={i}
              className="flex min-w-0 flex-wrap items-baseline gap-x-1 border-l-2 border-[var(--rule-2)] bg-[var(--surface-strong)] px-3 py-2 font-mono text-[11.5px] text-[var(--ink)]"
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
