"use client";

import Link from "next/link";
import clsx from "clsx";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppShell } from "@/components/chrome/AppShell";
import { PageSkeleton } from "@/components/chrome/PageSkeleton";
import { faculties } from "@/lib/faculties";
import type {
  PromotedFacultyGroup,
  PromotedFittingsView,
  ResolvedPromotedFitting
} from "@/lib/promoted-catalog";
import type {
  FacultyDefinition,
  FacultyId,
  FittingSelectionMap,
  LibraryEntry,
  SelectedFitting,
  VerifyResult
} from "@/lib/types";

// The 7 optional capability faculties (2026-06-24) — the homes the promoted
// Claude Code primitives fill. They render as Fitting card-blocks (not core
// composition tiles). `memory` also carries a promoted Fitting but is shown as
// its core role tile, so it is excluded from the capability blocks.
const CAPABILITY_FACULTIES = new Set<FacultyId>([
  "knowledge",
  "research",
  "building",
  "code-intelligence",
  "design",
  "browser-qa",
  "coordination"
]);

export function StationGrid() {
  const {
    composition,
    library,
    runnerState,
    saveComposition,
    busy,
    vaultNeedsPassword
  } = useAppShell();

  const params = useSearchParams();
  const router = useRouter();
  const [search, setSearch] = useState(params?.get("q") ?? "");

  // The promoted Fittings — the Claude Code primitives (formerly the separate
  // "Claude Code components" group) presented as first-class Fittings, grouped by
  // capability faculty under their Agent/Dev tier. Sourced from the live Quarters
  // discovery via /api/promoted-fittings (reuses the existing StateModel engine).
  const [promoted, setPromoted] = useState<PromotedFittingsView | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/promoted-fittings")
      .then((r) => r.json())
      .then((d) => {
        if (alive && d && !d.error) setPromoted(d as PromotedFittingsView);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const verifyResults = runnerState?.verifyResults ?? [];

  // Two genuinely different numbers that the old UI conflated under the
  // "fittings" label: how many faculty stations have at least one Fitting, and
  // how many Fittings are stationed in total.
  const stationedFaculties = useMemo(() => {
    if (!composition) return 0;
    return Object.values(composition.selections).reduce(
      (acc, sels) => acc + ((sels?.length ?? 0) > 0 ? 1 : 0),
      0
    );
  }, [composition]);
  const totalFittings = useMemo(() => {
    if (!composition) return 0;
    return Object.values(composition.selections).reduce((acc, sels) => acc + (sels?.length ?? 0), 0);
  }, [composition]);

  const verifyTotal = verifyResults.length;
  const verifyOk = verifyResults.filter((r) => r.ok).length;
  const isRunning = runnerState?.status === "running";

  const query = search.trim().toLowerCase();
  const searching = query.length > 0;
  const results = useMemo(() => {
    if (!searching) return [];
    return library
      .filter((entry) => {
        const fac = faculties.find((f) => f.id === entry.faculty);
        const haystack = `${entry.name} ${entry.summary} ${entry.id} ${entry.faculty} ${fac?.name ?? ""}`.toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [library, searching, query]);

  function updateSearch(next: string) {
    setSearch(next);
    const sp = new URLSearchParams(Array.from(params?.entries() ?? []));
    if (next.trim()) sp.set("q", next.trim());
    else sp.delete("q");
    const qs = sp.toString();
    router.replace(qs ? `/compose?${qs}` : "/compose", { scroll: false });
  }

  function isSelected(entry: LibraryEntry): boolean {
    if (!composition) return false;
    return (composition.selections[entry.faculty] ?? []).some((s) => s.id === entry.id);
  }

  function toggleSelection(entry: LibraryEntry) {
    if (!composition) return;
    const faculty = faculties.find((f) => f.id === entry.faculty);
    const current = composition.selections[entry.faculty] ?? [];
    const exists = current.some((s) => s.id === entry.id);
    const selections: FittingSelectionMap = { ...composition.selections };
    if (faculty?.cardinality === "single") {
      if (exists) delete selections[entry.faculty];
      else selections[entry.faculty] = [defaultSelection(entry)];
    } else {
      const next = exists
        ? current.filter((s) => s.id !== entry.id)
        : [...current, defaultSelection(entry)];
      if (next.length === 0) delete selections[entry.faculty];
      else selections[entry.faculty] = next;
    }
    void saveComposition({ selections });
  }

  if (!composition) {
    return <PageSkeleton label="Loading composition" />;
  }

  const orchestratorMissing = (composition.selections.orchestrator ?? []).length === 0;

  return (
    <main>
      <div className="crumbs">
        Composition · <b>Overview</b>
      </div>
      <div className="page">
        <div className="head">
          <h1>{composition.name}</h1>
          <p className="ld">
            {faculties.length} Faculty stations · {totalFittings} Fitting{totalFittings === 1 ? "" : "s"} stationed.
            Click a tile to configure that station, or search to find Fittings across every Faculty.
          </p>
        </div>

        <div className="strip">
          <span className={clsx("pill", isRunning && "live", statusToneClass(runnerState?.status))}>
            {isRunning ? <span className="dot" /> : null}
            {runnerState?.status ?? "idle"}
          </span>
          <span className="sep" />
          <span>
            faculties · <b>{stationedFaculties} / {faculties.length}</b>
          </span>
          <span>
            fittings · <b>{totalFittings}</b>
          </span>
          <span>
            verify · <b>{verifyTotal ? `${verifyOk} / ${verifyTotal}` : "—"}</b>
          </span>
          <span>
            capabilities ·{" "}
            <b
              style={{
                color:
                  composition.capabilityIssues.length === 0
                    ? "var(--sage)"
                    : "var(--alarm)"
              }}
            >
              {composition.capabilityIssues.length === 0
                ? "resolved"
                : `${composition.capabilityIssues.length} issue${composition.capabilityIssues.length === 1 ? "" : "s"}`}
            </b>
          </span>
          {vaultNeedsPassword ? (
            <span>
              vault · <b style={{ color: "var(--alarm)" }}>unguarded</b>
            </span>
          ) : null}
        </div>

        <div className="compose-search" style={{ position: "relative", margin: "0 0 18px" }}>
          <input
            type="search"
            value={search}
            onChange={(e) => updateSearch(e.target.value)}
            placeholder="Search every Faculty · Fitting name, summary, capability…"
            aria-label="Search Fittings across all Faculties"
            style={{
              width: "100%",
              padding: "11px 14px",
              fontSize: 14,
              border: "1px solid var(--rule)",
              background: "white",
              color: "var(--ink)",
              fontFamily: "inherit"
            }}
          />
          {searching ? (
            <button
              type="button"
              onClick={() => updateSearch("")}
              className="font-mono"
              style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                border: "1px solid var(--rule)",
                background: "var(--paper)",
                color: "var(--mute)",
                fontSize: 11,
                padding: "3px 8px",
                cursor: "pointer"
              }}
            >
              clear
            </button>
          ) : null}
        </div>

        {!searching && orchestratorMissing ? (
          <div className="banner alarm">
            <span className="glyph">!</span>
            <div style={{ flex: 1 }}>
              <h5>Orchestrator station is empty</h5>
              <p>
                The Operative needs a single governing Fitting to assemble its system prompt. Until one is
                stationed, <code>Run</code> falls back to a stub orchestrator.
              </p>
              <div className="actions">
                <Link href="/compose/orchestrator">Open Orchestrator station →</Link>
                <button type="button" className="linklike" onClick={() => updateSearch("orchestrator")}>
                  Search Orchestrator Fittings
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {!searching && composition.capabilityIssues.length > 0 ? (
          <div className="banner warn">
            <span className="glyph">!</span>
            <div style={{ flex: 1 }}>
              <h5>
                {composition.capabilityIssues.length} capability issue
                {composition.capabilityIssues.length === 1 ? "" : "s"}
              </h5>
              <p>
                Selected Fittings consume capabilities that aren&apos;t cleanly resolved. Click a station to
                fix it.
              </p>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55 }}>
                {composition.capabilityIssues.map((issue, i) => (
                  <li key={`${issue.fittingId}-${i}`}>
                    <code>{issue.kind}</code>
                    {issue.name ? <code>:{issue.name}</code> : null} —{" "}
                    {issueDetail(issue)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {searching ? (
          <SearchResults
            results={results}
            isSelected={isSelected}
            toggleSelection={toggleSelection}
            busy={Boolean(busy)}
          />
        ) : (
          <>
            <TierSection
              tier="agent"
              title="Agent faculties"
              blurb="The everyday operative — always available. Its brain (Orchestrator), Memory, the Channels you reach it through, the Gateway it runs on, its persona, plus what it knows and can look up."
              composition={composition}
              library={library}
              verifyResults={verifyResults}
              capabilityGroups={promoted?.agent ?? null}
            />

            <TierSection
              tier="dev"
              title="Dev faculties"
              blurb="Switched on for development work — alternative engines, observability, the dev session and surfaces, and the capabilities for building, understanding, designing, testing, and coordinating software."
              composition={composition}
              library={library}
              verifyResults={verifyResults}
              capabilityGroups={promoted?.dev ?? null}
              footer={
                composition.derivedTasks ? (
                  <div
                    style={{
                      gridColumn: "span 2",
                      background: "var(--paper-2)",
                      border: "1px dashed var(--rule-2)",
                      padding: "20px 18px",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "center"
                    }}
                  >
                    <div
                      className="font-mono"
                      style={{
                        fontSize: 10,
                        letterSpacing: "0.16em",
                        textTransform: "uppercase",
                        color: "var(--mute)",
                        marginBottom: 6
                      }}
                    >
                      Tasks · derived
                    </div>
                    <div className="font-display" style={{ fontWeight: 600, fontSize: 16 }}>
                      Tasks flow through {prettySource(composition.derivedTasks.source)}
                    </div>
                    <div className="font-mono" style={{ fontSize: 11.5, color: "var(--mute)", marginTop: 6 }}>
                      truth file · <b style={{ color: "var(--ink)" }}>{composition.derivedTasks.truthFile}</b>
                    </div>
                  </div>
                ) : null
              }
            />
          </>
        )}
      </div>
    </main>
  );
}

// One Compose tier section — "Agent faculties" or "Dev faculties". Holds the
// core composition-role tiles for that tier, then the optional capability
// faculties (each a labeled block of promoted Fitting cards). The two-header
// split is presentation only; the tier tag is orthogonal to essential/optional.
function TierSection({
  tier,
  title,
  blurb,
  composition,
  library,
  verifyResults,
  capabilityGroups,
  footer
}: {
  tier: "agent" | "dev";
  title: string;
  blurb: string;
  composition: { selections: FittingSelectionMap };
  library: LibraryEntry[];
  verifyResults: VerifyResult[];
  capabilityGroups: PromotedFacultyGroup[] | null;
  footer?: ReactNode;
}) {
  const coreRoles = faculties.filter((f) => f.tier === tier && !CAPABILITY_FACULTIES.has(f.id));
  const capBlocks = (capabilityGroups ?? []).filter((g) => CAPABILITY_FACULTIES.has(g.faculty));
  return (
    <section data-testid={`tier-section-${tier}`} style={{ marginBottom: 28 }}>
      <div style={{ margin: "0 0 10px" }}>
        <h2 className="font-display" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
          {title}
        </h2>
        <p className="font-mono" style={{ fontSize: 11.5, color: "var(--mute)", margin: "3px 0 0", lineHeight: 1.5 }}>
          {blurb}
        </p>
      </div>
      <div
        className="compose-station-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 220px), 1fr))",
          gap: 10
        }}
      >
        {coreRoles.map((faculty) => (
          <StationTile
            key={faculty.id}
            faculty={faculty}
            selections={composition.selections[faculty.id] ?? []}
            library={library}
            verifyResults={verifyResults}
          />
        ))}
        {footer}
      </div>

      {capabilityGroups == null ? (
        <div className="font-mono" style={{ fontSize: 11, color: "var(--mute)", marginTop: 14 }}>
          loading capabilities…
        </div>
      ) : (
        capBlocks.map((group) => <CapabilityFacultyBlock key={group.faculty} group={group} />)
      )}
    </section>
  );
}

// One optional capability faculty — its name + role copy, then its promoted
// Fitting cards. This is what replaced the old primitive-typed "Claude Code
// components" tiles: each card is a first-class Fitting, never a "skill"/"MCP".
function CapabilityFacultyBlock({ group }: { group: PromotedFacultyGroup }) {
  return (
    <div data-testid={`capability-faculty-${group.faculty}`} style={{ margin: "16px 0 4px" }}>
      <div
        className="font-mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--brass)",
          margin: "0 0 8px"
        }}
      >
        {group.facultyName}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))",
          gap: 10
        }}
      >
        {group.fittings.map((f) => (
          <PromotedFittingCard key={f.id} fitting={f} />
        ))}
      </div>
    </div>
  );
}

// A single promoted Fitting card — title, plain-language description, and an
// installed/available pip. Links to the Fitting's detail view (where its setup
// instructions are edited). The primitive type behind it is never shown here.
function PromotedFittingCard({ fitting }: { fitting: ResolvedPromotedFitting }) {
  return (
    <Link
      href={`/fitting/promoted/${fitting.id}`}
      data-testid={`promoted-fitting-${fitting.id}`}
      style={{
        border: "1px solid var(--rule)",
        background: "white",
        padding: "13px 15px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        textDecoration: "none",
        color: "inherit"
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div className="font-display" style={{ fontWeight: 600, fontSize: 15 }}>
          {fitting.title}
        </div>
        <span
          className="font-mono"
          title={fitting.present ? "Installed in ~/.claude" : "Not installed"}
          style={{
            fontSize: 9.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: fitting.present ? "var(--sage)" : "var(--mute)",
            whiteSpace: "nowrap"
          }}
        >
          {fitting.present ? "installed" : "available"}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--mute)", lineHeight: 1.5 }}>{fitting.descriptionPlain}</div>
    </Link>
  );
}

function SearchResults({
  results,
  isSelected,
  toggleSelection,
  busy
}: {
  results: LibraryEntry[];
  isSelected: (entry: LibraryEntry) => boolean;
  toggleSelection: (entry: LibraryEntry) => void;
  busy: boolean;
}) {
  if (results.length === 0) {
    return (
      <div style={{ padding: 36, textAlign: "center", color: "var(--mute)", border: "1px solid var(--rule)", background: "white" }}>
        No Fittings match that search.
      </div>
    );
  }
  return (
    <>
      <div className="font-mono" style={{ fontSize: 11, color: "var(--mute)", margin: "0 0 10px", letterSpacing: "0.04em" }}>
        {results.length} Fitting{results.length === 1 ? "" : "s"} across {new Set(results.map((r) => r.faculty)).size} Facult
        {new Set(results.map((r) => r.faculty)).size === 1 ? "y" : "ies"}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))",
          gap: 12
        }}
      >
        {results.map((entry) => {
          const selected = isSelected(entry);
          const fac = faculties.find((f) => f.id === entry.faculty);
          return (
            <div
              key={entry.id}
              style={{
                border: `1px solid ${selected ? "var(--sage)" : "var(--rule)"}`,
                background: "white",
                padding: "14px 16px",
                display: "flex",
                flexDirection: "column",
                gap: 8
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <div className="font-display" style={{ fontWeight: 600, fontSize: 15 }}>
                  {entry.name}
                </div>
                <span
                  className="font-mono"
                  style={{
                    fontSize: 9.5,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: "var(--brass)",
                    whiteSpace: "nowrap"
                  }}
                >
                  {fac?.name ?? entry.faculty}
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--mute)", lineHeight: 1.5, flex: 1 }}>
                {entry.summary}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 2 }}>
                <Link
                  href={`/compose/${entry.faculty}`}
                  className="font-mono"
                  style={{ fontSize: 11, color: "var(--ink)", textDecoration: "underline" }}
                >
                  open station →
                </Link>
                <button
                  type="button"
                  className={clsx("btn small", selected ? "ghost" : "primary")}
                  disabled={busy}
                  onClick={() => toggleSelection(entry)}
                >
                  {selected ? "Remove" : "Add"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function StationTile({
  faculty,
  selections,
  library,
  verifyResults
}: {
  faculty: FacultyDefinition;
  selections: SelectedFitting[];
  library: LibraryEntry[];
  verifyResults: VerifyResult[];
}) {
  const stationed = selections.length > 0;
  const available = library.filter((e) => e.faculty === faculty.id).length;
  const isCapstone = faculty.governing;
  const orchestratorMissing = faculty.id === "orchestrator" && !stationed;

  let glyph = "·";
  let className = "tile empty";
  if (orchestratorMissing) {
    glyph = "!";
    className = "tile alarm capstone";
  } else if (stationed) {
    const fittingIds = new Set(selections.map((s) => s.id));
    const ownVerifies = verifyResults.filter((r) => fittingIds.has(r.fittingId));
    if (ownVerifies.length === 0) {
      // Stationed but verify hasn't run — neutral pip, not sage.
      glyph = "•";
      className = "tile empty";
    } else if (ownVerifies.some((r) => !r.ok)) {
      glyph = "!";
      className = "tile alarm";
    } else {
      glyph = "•";
      className = "tile verified";
    }
  }
  if (isCapstone && !orchestratorMissing) {
    className += " capstone";
    glyph = stationed ? "•" : "·";
  }

  const primaryName = stationed ? humanName(library, selections[0].id) : faculty.name;
  const sub = stationed ? subFor(faculty.id, selections, library) : faculty.cardinality === "multi" ? "no Fittings · multi slot" : "no Fitting · single slot";

  return (
    <Link
      href={`/compose/${faculty.id}`}
      className={`station-tile ${className}`}
    >
      <div className="t-top">
        <span className="t-num">
          {String(faculty.order).padStart(2, "0")} · {faculty.name}
        </span>
        <span className="t-glyph">{glyph}</span>
      </div>
      <div className="t-nm">{primaryName}</div>
      <div className="t-fit" dangerouslySetInnerHTML={{ __html: sub }} />
      <div
        className="font-mono t-count"
        title={`${selections.length} selected of ${available} available`}
        style={{ fontSize: 10.5, color: "var(--mute)", marginTop: 8, letterSpacing: "0.06em" }}
      >
        <b style={{ color: stationed ? "var(--ink)" : "var(--mute)" }}>{selections.length}</b> selected · {available} available
      </div>
    </Link>
  );
}

function defaultSelection(entry: LibraryEntry): SelectedFitting {
  return {
    id: entry.id,
    config: Object.fromEntries(
      entry.metadata.config_schema
        .filter((field) => field.default !== undefined)
        .map((field) => [field.key, field.default as string | number | boolean])
    )
  };
}

function humanName(library: LibraryEntry[], id: string): string {
  return library.find((e) => e.id === id)?.name ?? id;
}

function subFor(id: FacultyId, selections: SelectedFitting[], library: LibraryEntry[]): string {
  if (selections.length > 1) {
    const first = library.find((e) => e.id === selections[0].id);
    return `<b>${selections.length}</b> stationed · ${first?.name ?? selections[0].id}${selections.length > 1 ? " +" + (selections.length - 1) : ""}`;
  }
  const sel = selections[0];
  switch (id) {
    case "memory":
      return `<b>${sel.config?.persistence_cadence ?? "hourly"}</b> persistence · ${sel.config?.recency_window ?? 20}-line recency`;
    case "gateway":
      return `${sel.config?.bind_host ?? "127.0.0.1"}<b>:${sel.config?.port ?? 4777}</b>`;
    default: {
      // The tile title already shows the Fitting's name; the sub-line earns its
      // space by saying what the Fitting DOES (transparency principle), not by
      // repeating the name.
      const entry = library.find((e) => e.id === sel.id);
      if (!entry?.summary) return entry?.name ?? sel.id;
      const firstSentence = entry.summary.split(/(?<=[.!?])\s/)[0] ?? entry.summary;
      let clipped = firstSentence;
      if (clipped.length > 110) {
        const cut = clipped.slice(0, 107);
        clipped = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 80)).trimEnd()}…`;
      }
      return escapeHtml(clipped);
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusToneClass(status: string | undefined): string {
  if (status === "running") return "";
  if (status === "failed") return "alarm";
  if (status === "starting" || status === "verifying" || status === "stopping") return "warn";
  return "idle";
}

function prettySource(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function issueDetail(issue: { code: string; fittingId: string }): string {
  switch (issue.code) {
    case "missing-required":
      return `${issue.fittingId} requires this; no provider in composition.`;
    case "ambiguous-singleton":
      return `${issue.fittingId} consumes a singleton; more than one provider.`;
    case "too-many-for-optional":
      return `${issue.fittingId} consumes optional-one; more than one provider.`;
    case "unknown-kind":
      return `${issue.fittingId} declares an unknown capability kind.`;
    default:
      return `${issue.fittingId}: ${issue.code}`;
  }
}
