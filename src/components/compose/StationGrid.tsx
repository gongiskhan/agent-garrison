"use client";

import Link from "next/link";
import clsx from "clsx";
import { useMemo } from "react";
import { useAppShell } from "@/components/chrome/AppShell";
import { faculties } from "@/lib/faculties";
import type { FacultyDefinition, FacultyId, LibraryEntry, SelectedFitting, VerifyResult } from "@/lib/types";

export function StationGrid() {
  const {
    composition,
    library,
    runnerState,
    saveComposition,
    busy,
    vaultNeedsPassword
  } = useAppShell();

  const verifyResults = runnerState?.verifyResults ?? [];

  const stationedCount = useMemo(() => {
    if (!composition) return 0;
    return Object.values(composition.selections).reduce((acc, sels) => {
      return acc + ((sels?.length ?? 0) > 0 ? 1 : 0);
    }, 0);
  }, [composition]);

  const verifyTotal = verifyResults.length;
  const verifyOk = verifyResults.filter((r) => r.ok).length;
  const isRunning = runnerState?.status === "running";

  if (!composition) {
    return (
      <main>
        <div className="page">
          <div className="head">
            <h1>Loading composition…</h1>
          </div>
        </div>
      </main>
    );
  }

  const orchestratorMissing = (composition.selections.orchestrator ?? []).length === 0;

  return (
    <main>
      <div className="crumbs">
        Compose · <b>Overview</b>
      </div>
      <div className="page">
        <div className="head">
          <h1>{composition.name}</h1>
          <p className="ld">
            {faculties.length} Faculty stations. {stationedCount} stationed. Click any tile to configure that station —
            long-form copy, Fitting picker, capability wiring, and per-Fitting extensions live on the
            station&apos;s own page, not here.
          </p>
        </div>

        <div className="strip">
          <span className={clsx("pill", isRunning && "live", statusToneClass(runnerState?.status))}>
            {isRunning ? <span className="dot" /> : null}
            {runnerState?.status ?? "idle"}
          </span>
          <span className="sep" />
          <span>
            fittings · <b>{stationedCount}</b>
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

        {orchestratorMissing ? (
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
                <Link href="/armory?faculty=orchestrator">Browse Orchestrator Fittings</Link>
              </div>
            </div>
          </div>
        ) : null}

        {composition.capabilityIssues.length > 0 ? (
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

        <div
          className="compose-station-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 220px), 1fr))",
            gap: 10
          }}
        >
          {faculties.map((faculty) => (
            <StationTile
              key={faculty.id}
              faculty={faculty}
              selections={composition.selections[faculty.id] ?? []}
              library={library}
              verifyResults={verifyResults}
            />
          ))}

          {composition.derivedTasks ? (
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
          ) : null}
        </div>
      </div>
    </main>
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
    </Link>
  );
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
    default:
      return library.find((e) => e.id === sel.id)?.name ?? sel.id;
  }
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

