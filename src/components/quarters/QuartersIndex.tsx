"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as Lucide from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { StateModel, PrimitiveSurface } from "@/lib/primitive-state";
import type { RuntimeQuartersEntry } from "@/lib/quarters-runtimes";
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

// D6: expand state persists locally per runtime section — no new state store.
const EXPAND_KEY = "quarters.sections.expanded";

function readExpandState(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(EXPAND_KEY) ?? "{}");
    // Shape-validate (S7 codex ratchet): JSON "null"/"42"/"[]" parse fine but
    // are not usable maps — indexing null would crash the render.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
    return {};
  } catch {
    return {};
  }
}

// Generic-tier category labels (rendered from the descriptor's category list).
const GENERIC_CATEGORY_META: Record<string, { label: string; blurb: string; icon: string }> = {
  settings: { label: "Settings", blurb: "The engine's native settings file(s), edited raw with format validation.", icon: "SlidersHorizontal" },
  context: { label: "Context", blurb: "The engine's context-file convention, ownership-aware.", icon: "NotebookText" },
  mcps: { label: "MCPs", blurb: "MCP servers as the engine's native config declares them.", icon: "Plug" },
  logs: { label: "Logs", blurb: "Tail the engine's log output, read-only.", icon: "FileText" }
};

export function QuartersIndex() {
  const [model, setModel] = useState<StateModel | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeQuartersEntry[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setExpanded(readExpandState());
    fetch("/api/quarters")
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        if (d?.error) setError(String(d.error));
        else setModel(d as StateModel);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    fetch(
      `/api/quarters/runtimes${(() => {
        if (typeof window === "undefined") return "";
        const c = new URLSearchParams(window.location.search).get("composition");
        return c ? `?composition=${encodeURIComponent(c)}` : "";
      })()}`
    )
      .then((r) => r.json())
      .then((d) => active && setRuntimes(Array.isArray(d) ? (d as RuntimeQuartersEntry[]) : []))
      .catch(() => active && setRuntimes([]));
    return () => {
      active = false;
    };
  }, []);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        window.localStorage.setItem(EXPAND_KEY, JSON.stringify(next));
      } catch {
        /* private mode etc. — expand state just doesn't persist */
      }
      return next;
    });
  };

  // D6: sections follow the COMPOSITION. Exactly one configurable runtime (the
  // common case: claude-code) → its surface renders expanded with the current
  // look preserved. More than one → every runtime is a collapsible section and
  // ALL start collapsed, so each engine's configurability is visible at a
  // glance without scrolling past a fully expanded Claude Code surface.
  const sections = runtimes ?? [];
  const multi = sections.length > 1;
  const loading = runtimes === null;

  return (
    <main>
      <div className="crumbs"><b>Quarters</b></div>
      <div className="page">
        <div className="head">
          <h1>Quarters</h1>
          <p className="ld">
            The native configuration of every runtime selected in the composition. Claude Code keeps
            its full surface over the real <code>~/.claude</code> (owned / loose primitives, APM-compiled
            packages); other engines render a generic tier from their Fitting&apos;s Quarters descriptor.
          </p>
        </div>

        {error ? (
          <div className="banner alarm" data-testid="quarters-error">
            <span className="glyph">!</span>
            <div><h5>Could not read ~/.claude</h5><p>{error}</p></div>
          </div>
        ) : null}

        {loading ? (
          // No flash (S7 review): don't paint the classic grid before the
          // runtimes feed decides single-vs-multi.
          <div className="quarters-note">loading…</div>
        ) : !multi ? (
          // Single runtime: the classic claude-code index, exactly as before.
          <div
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}
            data-testid="quarters-grid"
          >
            {QUARTERS_CATEGORIES.map((cat) => (
              <CategoryCard key={cat.slug} cat={cat} model={model} />
            ))}
          </div>
        ) : (
          sections.map((entry) => {
            const isOpen = !!expanded[entry.fittingId];
            const deep = entry.descriptor.tier === "deep";
            return (
              <section
                key={entry.fittingId}
                data-testid={`quarters-section-${entry.fittingId}`}
                style={{ border: "1px solid var(--rule)", background: "white", marginBottom: 14 }}
              >
                <button
                  type="button"
                  data-testid={`quarters-section-toggle-${entry.fittingId}`}
                  onClick={() => toggle(entry.fittingId)}
                  aria-expanded={isOpen}
                  style={{
                    display: "flex",
                    width: "100%",
                    alignItems: "center",
                    gap: 10,
                    padding: "12px 16px",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left"
                  }}
                >
                  <span className="glyph">{isOpen ? <Lucide.ChevronDown size={14} aria-hidden /> : <Lucide.ChevronRight size={14} aria-hidden />}</span>
                  <h2 className="font-display" style={{ margin: 0, fontSize: 16, flex: 1 }}>
                    {entry.engine}
                  </h2>
                  <span className="pill idle" style={{ fontSize: 10 }}>
                    {deep ? "full surface" : "generic tier"}
                  </span>
                  {entry.warnings.length ? (
                    <span className="pill warn" style={{ fontSize: 10 }} title={entry.warnings.join("; ")}>
                      {entry.warnings.length} warning{entry.warnings.length > 1 ? "s" : ""}
                    </span>
                  ) : null}
                </button>
                {isOpen ? (
                  <div style={{ padding: "0 16px 16px" }}>
                    {entry.warnings.length ? (
                      <div className="banner warn" style={{ marginBottom: 12 }}>
                        {entry.warnings.join("; ")}
                      </div>
                    ) : null}
                    {deep ? (
                      <div
                        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}
                        data-testid="quarters-grid"
                      >
                        {QUARTERS_CATEGORIES.map((cat) => (
                          <CategoryCard key={cat.slug} cat={cat} model={model} />
                        ))}
                      </div>
                    ) : (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
                        {(entry.descriptor.categories ?? ["settings", "context", "mcps", "logs"]).map((cat) => {
                          const meta = GENERIC_CATEGORY_META[cat] ?? { label: cat, blurb: "", icon: "Square" };
                          const Icon = icon(meta.icon);
                          return (
                            <Link
                              key={cat}
                              href={`/quarters/${entry.fittingId}/${cat}`}
                              data-testid={`quarters-card-${entry.fittingId}-${cat}`}
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
                                <h3 className="font-display" style={{ fontWeight: 600, fontSize: 15, margin: 0, flex: 1 }}>{meta.label}</h3>
                                <span className="pill idle" style={{ fontSize: 10 }}>native file</span>
                              </div>
                              <p style={{ margin: 0, color: "var(--mute)", fontSize: 12 }}>{meta.blurb}</p>
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}
              </section>
            );
          })
        )}
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
