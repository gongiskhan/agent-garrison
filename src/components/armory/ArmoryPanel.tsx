"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { useAppShell } from "@/components/chrome/AppShell";
import { faculties } from "@/lib/faculties";
import type { FacultyId, LibraryEntry } from "@/lib/types";

const groupForFaculty: Record<FacultyId, string> = {
  heartbeat: "Cadence",
  scheduler: "Cadence",
  "data-sources": "Context",
  "knowledge-base": "Context",
  memory: "Context",
  "artifact-store": "Context",
  automations: "Action",
  skills: "Action",
  gateway: "Action",
  channels: "Action",
  classifier: "Control",
  observability: "Control",
  soul: "Control",
  orchestrator: "Control",
  terminal: "Workbench",
  "screen-share": "Workbench",
  "worktree-management": "Workbench",
  "session-view": "Workbench"
};

export function ArmoryPanel() {
  const { composition, library } = useAppShell();
  const params = useSearchParams();
  const router = useRouter();

  const facultyFilter = params?.get("faculty") ?? "all";
  const shapeFilter = params?.get("shape") ?? "all";
  const platformFilter = params?.get("platform") ?? "all";
  const groupFilter = params?.get("group") ?? "all";
  const installedFilter = params?.get("installed") === "1";
  const [search, setSearch] = useState(params?.get("q") ?? "");

  const installedIds = useMemo(() => {
    const set = new Set<string>();
    if (!composition) return set;
    for (const sels of Object.values(composition.selections)) {
      for (const s of sels ?? []) set.add(s.id);
    }
    return set;
  }, [composition]);

  const filtered = useMemo(() => {
    return library.filter((entry) => {
      if (facultyFilter !== "all" && entry.faculty !== facultyFilter) return false;
      if (shapeFilter !== "all" && entry.metadata.component_shape !== shapeFilter) return false;
      if (
        platformFilter !== "all" &&
        !entry.platforms.includes(platformFilter) &&
        !(platformFilter === "all" || entry.platforms.includes("all"))
      )
        return false;
      if (groupFilter !== "all" && groupForFaculty[entry.faculty] !== groupFilter) return false;
      if (installedFilter && !installedIds.has(entry.id)) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const haystack = `${entry.name} ${entry.summary} ${entry.id}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [library, facultyFilter, shapeFilter, platformFilter, groupFilter, installedFilter, installedIds, search]);

  const counts = useMemo(() => {
    const c = { all: library.length, Cadence: 0, Context: 0, Action: 0, Control: 0, installed: installedIds.size };
    for (const entry of library) {
      const g = groupForFaculty[entry.faculty];
      if (g) (c as Record<string, number>)[g] = ((c as Record<string, number>)[g] ?? 0) + 1;
    }
    return c;
  }, [library, installedIds]);

  function setParam(key: string, value: string | undefined) {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (value === undefined || value === "all" || value === "") {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    router.replace(`/armory${next.toString() ? `?${next.toString()}` : ""}`, { scroll: false });
  }

  return (
    <main>
      <div className="crumbs">
        <b>Armory</b>
      </div>
      <div className="page wide">
        <div className="head">
          <h1>Armory</h1>
          <p className="ld">
            {library.length} vetted Fitting{library.length === 1 ? "" : "s"}, sourced from the curated registry. Search, filter, and install.
            Every Fitting passes the four-check validation pipeline before it reaches this list.
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto auto auto",
            gap: 12,
            alignItems: "center",
            padding: "10px 14px",
            border: "1px solid var(--rule)",
            background: "white",
            marginBottom: 14
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="font-mono" style={{ color: "var(--mute)", marginRight: 8, fontSize: 14 }}>
              ⌕
            </span>
            <input
              style={{
                border: "none",
                outline: "none",
                fontSize: 14,
                padding: "6px 4px",
                background: "transparent",
                width: "100%",
                color: "var(--ink)"
              }}
              value={search}
              placeholder="Search Fittings · name, summary, capability…"
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            style={{
              fontSize: 12.5,
              padding: "6px 8px",
              border: "1px solid var(--rule)",
              background: "var(--paper)",
              color: "var(--ink)"
            }}
            value={facultyFilter}
            onChange={(e) => setParam("faculty", e.target.value)}
          >
            <option value="all">All faculties</option>
            {faculties.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <select
            style={{
              fontSize: 12.5,
              padding: "6px 8px",
              border: "1px solid var(--rule)",
              background: "var(--paper)",
              color: "var(--ink)"
            }}
            value={shapeFilter}
            onChange={(e) => setParam("shape", e.target.value)}
          >
            <option value="all">All shapes</option>
            <option>script</option>
            <option>skill</option>
            <option>system-prompt</option>
            <option>cli</option>
            <option>cli-skill</option>
            <option>plugin</option>
            <option>hook</option>
            <option>mcp</option>
          </select>
          <select
            style={{
              fontSize: 12.5,
              padding: "6px 8px",
              border: "1px solid var(--rule)",
              background: "var(--paper)",
              color: "var(--ink)"
            }}
            value={platformFilter}
            onChange={(e) => setParam("platform", e.target.value)}
          >
            <option value="all">All platforms</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <Chip
            active={groupFilter === "all" && !installedFilter}
            onClick={() => {
              setParam("group", undefined);
              setParam("installed", undefined);
            }}
            label="All"
            ct={counts.all}
          />
          {(["Cadence", "Context", "Action", "Control"] as const).map((g) => (
            <Chip
              key={g}
              active={groupFilter === g}
              onClick={() => setParam("group", g)}
              label={g}
              ct={(counts as Record<string, number>)[g] ?? 0}
            />
          ))}
          <Chip
            active={installedFilter}
            onClick={() => setParam("installed", installedFilter ? undefined : "1")}
            label="Installed"
            ct={counts.installed}
            style={{ marginLeft: "auto" }}
          />
        </div>

        {filtered.length === 0 ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              border: "1px dashed var(--rule-2)",
              background: "var(--paper-2)",
              color: "var(--mute)"
            }}
          >
            No Fittings match these filters.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
            {filtered.map((entry) => (
              <FittingArmoryCard
                key={entry.id}
                entry={entry}
                installed={installedIds.has(entry.id)}
              />
            ))}
          </div>
        )}

        <div
          style={{
            border: "1px dashed var(--rule-2)",
            background: "var(--paper-2)",
            padding: "18px 22px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 18,
            marginTop: 18
          }}
        >
          <div>
            <h4 className="font-display" style={{ fontWeight: 600, fontSize: 16, margin: "0 0 4px" }}>
              Want to ship a Fitting?
            </h4>
            <p style={{ fontSize: 13, color: "var(--mute)", margin: 0, maxWidth: 540, lineHeight: 1.5 }}>
              Authoring isn&apos;t done in-app in v1. Initialise an APM package with an{" "}
              <code>x-garrison</code> block, run{" "}
              <code>tsx scripts/validate-fitting.ts &lt;path&gt;</code>, and submit through the issue-based
              flow that opens in v1.1.
            </p>
          </div>
          <a
            className="btn ghost"
            href="https://github.com/microsoft/apm"
            target="_blank"
            rel="noreferrer noopener"
          >
            CONTRIBUTING.md →
          </a>
        </div>
      </div>
    </main>
  );
}

function FittingArmoryCard({
  entry,
  installed
}: {
  entry: LibraryEntry;
  installed: boolean;
}) {
  const platforms = entry.platforms.length > 0 ? entry.platforms.join(", ") : "all";
  return (
    <article
      style={{
        border: `1px solid ${installed ? "var(--sage)" : "var(--rule)"}`,
        background: installed ? "var(--sage-soft)" : "white",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 8
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h3 className="font-display" style={{ fontWeight: 600, fontSize: 17, margin: 0, letterSpacing: "-0.005em" }}>
          {entry.name}
        </h3>
        <span
          className="font-mono"
          style={{
            fontSize: 9.5,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            padding: "3px 7px",
            border: `1px solid ${installed ? "var(--sage)" : "var(--rule)"}`,
            color: installed ? "var(--sage)" : "var(--mute)"
          }}
        >
          {installed ? "installed" : platforms}
        </span>
      </div>
      <div
        className="font-mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--mute)",
          display: "flex",
          gap: 10,
          flexWrap: "wrap"
        }}
      >
        <span>
          FACULTY ·{" "}
          <b style={{ color: "var(--ink)", fontFamily: "var(--font-sans), Inter, sans-serif", fontSize: 11, letterSpacing: 0, fontWeight: 600 }}>
            {capitalize(entry.faculty)}
          </b>
        </span>
        <span>SHAPE · {entry.metadata.component_shape}</span>
        {entry.metadata.provides.length > 0 ? (
          <span>PROVIDES · {entry.metadata.provides.map((p) => p.kind).join(", ")}</span>
        ) : null}
        {entry.metadata.consumes.length > 0 ? (
          <span>CONSUMES · {entry.metadata.consumes.map((c) => c.kind).join(", ")}</span>
        ) : null}
      </div>
      <p style={{ fontSize: 13, color: "var(--mute)", lineHeight: 1.55, margin: "4px 0 0" }}>
        {entry.summary}
      </p>
      <div
        style={{
          marginTop: "auto",
          paddingTop: 12,
          borderTop: `1px solid ${installed ? "rgba(47,74,58,0.2)" : "var(--rule)"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10
        }}
      >
        <div
          className="font-mono"
          style={{ display: "flex", gap: 14, fontSize: 11, color: "var(--mute)" }}
        >
          <span>
            cc{" "}
            <b style={{ color: "var(--ink)", fontFamily: "var(--font-sans), Inter, sans-serif", fontSize: 12, fontWeight: 600 }}>
              {entry.ratings.claude_code ?? "—"}
            </b>
          </span>
          <span>
            global{" "}
            <b style={{ color: "var(--ink)", fontFamily: "var(--font-sans), Inter, sans-serif", fontSize: 12, fontWeight: 600 }}>
              {entry.ratings.global ?? "—"}
            </b>
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Link className="btn small ghost" href={`/compose/${entry.faculty}`}>
            Open station
          </Link>
        </div>
      </div>
    </article>
  );
}

function Chip({
  active,
  onClick,
  label,
  ct,
  style
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  ct?: number;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx("font-mono", "armory-chip", active && "active")}
      style={style}
    >
      {label}
      {ct !== undefined ? <span className="ct">{ct}</span> : null}
    </button>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
