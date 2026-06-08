"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as Lucide from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { StateModel, PrimitiveSurface } from "@/lib/primitive-state";
import { QUARTERS_CATEGORIES, WRITER_LABEL, type QuartersCategory } from "./quartersTypes";

function icon(name: string): LucideIcon {
  return ((Lucide as unknown as Record<string, LucideIcon>)[name] ?? Lucide.Square) as LucideIcon;
}

function surfaceCounts(model: StateModel | null, surfaces: PrimitiveSurface[]): { owned: number; loose: number } {
  if (!model) return { owned: 0, loose: 0 };
  let owned = 0;
  let loose = 0;
  for (const s of surfaces) {
    for (const r of model.bySurface[s] ?? []) {
      if (r.state === "owned") owned += 1;
      else if (r.state === "loose") loose += 1;
    }
  }
  return { owned, loose };
}

export function QuartersIndex() {
  const [model, setModel] = useState<StateModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/quarters")
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        if (d?.error) setError(String(d.error));
        else setModel(d as StateModel);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, []);

  return (
    <main>
      <div className="crumbs"><b>Quarters</b></div>
      <div className="page">
        <div className="head">
          <h1>Quarters</h1>
          <p className="ld">
            Every Claude Code artifact type in your real <code>~/.claude</code>, by name. Package
            primitives are compiled by APM; settings, hooks, and documents are written by Garrison;
            logs and sessions are read-only. Each primitive is <b>owned</b> (managed by Garrison via
            APM) or <b>loose</b> (on disk, hand-authored).
          </p>
        </div>

        {error ? (
          <div className="banner alarm" data-testid="quarters-error">
            <span className="glyph">!</span>
            <div><h5>Could not read ~/.claude</h5><p>{error}</p></div>
          </div>
        ) : null}

        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}
          data-testid="quarters-grid"
        >
          {QUARTERS_CATEGORIES.map((cat) => (
            <CategoryCard key={cat.slug} cat={cat} model={model} />
          ))}
        </div>
      </div>
    </main>
  );
}

function CategoryCard({ cat, model }: { cat: QuartersCategory; model: StateModel | null }) {
  const Icon = icon(cat.icon);
  const counts = cat.surfaces ? surfaceCounts(model, cat.surfaces) : null;
  return (
    <Link
      href={`/quarters/${cat.slug}`}
      data-testid={`quarters-card-${cat.slug}`}
      style={{
        display: "block",
        border: "1px solid var(--rule)",
        background: "white",
        padding: "14px 16px",
        textDecoration: "none",
        color: "inherit"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span className="glyph"><Icon size={16} aria-hidden /></span>
        <h3 className="font-display" style={{ fontWeight: 600, fontSize: 15, margin: 0, flex: 1 }}>{cat.label}</h3>
        <span className="pill idle" style={{ fontSize: 10 }}>{WRITER_LABEL[cat.writer]}</span>
      </div>
      <p style={{ margin: "0 0 8px", color: "var(--mute)", fontSize: 12 }}>{cat.blurb}</p>
      {counts ? (
        <div style={{ display: "flex", gap: 8, fontSize: 11.5, color: "var(--mute)" }}>
          <span className="pill verified" style={{ fontSize: 10.5 }}>{counts.owned} owned</span>
          <span className="pill warn" style={{ fontSize: 10.5 }}>{counts.loose} loose</span>
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: "var(--mute)" }}>
          {cat.kind === "readonly" ? "read-only" : "open to edit"}
        </div>
      )}
    </Link>
  );
}
