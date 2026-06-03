"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import clsx from "clsx";
import { useAppShell } from "@/components/chrome/AppShell";
import { FittingView } from "@/components/fitting-views/FittingView";
import { FittingOverview } from "@/components/fitting-views/FittingOverview";
import { matchView } from "@/lib/fitting-views";
import { faculties } from "@/lib/faculties";
import type {
  Composition,
  ConfigSchemaField,
  FacultyDefinition,
  FacultyId,
  GlobalConfig,
  LibraryEntry,
  SelectedFitting
} from "@/lib/types";

const facultyRoleCopy: Record<FacultyId, { role: string; fit: string }> = {
  heartbeat: {
    role: "Defines when the operative wakes up without a human prompt.",
    fit: "It triggers the gateway on a cadence, so routine work starts from the same entry point as inbound channel events."
  },
  scheduler: {
    role: "Handles scheduled work that is not part of the heartbeat loop.",
    fit: "Use this for one-off or calendar-like jobs that should not change the main wake cadence."
  },
  "data-sources": {
    role: "Feeds live external state into the operative.",
    fit: "Data sources are read paths. If the stationed source declares a task store, the derived Tasks Faculty follows it automatically."
  },
  "knowledge-base": {
    role: "Provides static references the operative can read.",
    fit: "Use this for docs, codebases, policies, and project context that should inform work but not act as live integrations."
  },
  automations: {
    role: "Gives the operative tools that can act in the world.",
    fit: "Browser, desktop, or scripted UI control belongs here; testing can reuse these when it needs to drive an interface."
  },
  skills: {
    role: "Reusable capabilities the Operative can invoke during work.",
    fit: "A Fitting here exposes a skill — a procedure, helper, or test author — that the Orchestrator can call as a sub-agent or tool."
  },
  memory: {
    role: "Controls what the operative remembers within and across sessions.",
    fit: "A single Memory Fitting owns recency, persistence cadence, and compiled memory output."
  },
  classifier: {
    role: "Classifies each prompt before work starts.",
    fit: "This is an operative Fitting, not a separate app surface. It sets the routing floor and escalation behavior."
  },
  gateway: {
    role: "Receives jobs from heartbeat, channels, and local test inputs.",
    fit: "The gateway is the MCP-speaking front door; public exposure remains a manual documented step in v1."
  },
  channels: {
    role: "Connects real user-facing message surfaces.",
    fit: "Slack, Discord, Telegram, WhatsApp, and custom UIs belong here. The Run test box is not a channel."
  },
  observability: {
    role: "Reports health, errors, no-ops, and runtime state.",
    fit: "Observability routes loop outcomes to logs or alert channels so silent failure is not treated as success."
  },
  soul: {
    role: "Defines identity, tone, voice, and boundaries.",
    fit: "The runner concatenates orchestrator first, then soul, to produce the system prompt passed to Claude Code."
  },
  orchestrator: {
    role: "Governs the operative's behavior.",
    fit: "This is the capstone. It coordinates Faculties, owns global config, and provides the behavioral spine."
  },
  "artifact-store": {
    role: "Stores files the Operative or its Fittings produce — documents, recordings, audio.",
    fit: "Other Fittings (Documents next, Automations recordings later) layer their own schemas on top of this single shared backing store."
  },
  terminal: {
    role: "Provides PTY-backed terminal sessions on the Fitting's own port (default 7078).",
    fit: "Stand-alone Fitting; visible from the Tools discovery page when running."
  },
  "screen-share": {
    role: "Captures the macOS display and streams JPEG frames on the Fitting's own port (default 7079).",
    fit: "Useful for monitoring or reviewing the desktop from a phone via the Tailscale URL."
  },
  "worktree-management": {
    role: "Manages git worktrees for parallel branch work; runs on its own port (default 7080).",
    fit: "Creates isolated worktrees and updates ~/.garrison/sessions/state.json so the session-view Fitting picks them up."
  },
  "session-view": {
    role: "Shows Claude Code session status across git worktrees; runs on its own port (default 7081).",
    fit: "Badges reflect live session health (idle/working/waiting/errored) driven by Claude Code hooks."
  },
  outposts: {
    role: "Connects remote Macs as managed outposts over Garrison Outpost Protocol v1; runs on its own port (default 7082).",
    fit: "Each Outpost Fitting represents one remote machine. Spawn processes, watch files, and manage git worktrees remotely."
  },
  sync: {
    role: "Periodically mirrors files between the host and remote outpost machines.",
    fit: "v1 is host→outpost unidirectional. Use for Obsidian vaults, dotfiles, or any directory you want to keep in sync across your machines."
  },
  monitor: {
    role: "Read-only visibility into every entity Garrison spawns.",
    fit: "The default Fitting serves its own UI on its own port and walks Garrison's PID tree to surface PIDs, ports, network connections, and tee'd stdout/stderr."
  },
  "web-channel": {
    role: "Mobile-first browser chat surface for talking to the Operative.",
    fit: "Distinct from the desktop shell — this Fitting serves its own React UI on its own port (default 7083) and provides a kind:channel capability that the Orchestrator routes to like Slack."
  },
  browser: {
    role: "Headless Chromium substrate Garrison owns and exposes over HTTP/WS.",
    fit: "Default Fitting runs Chromium on port 7084 with per-tab JPEG screencast, mouse/key/touch input, raw CDP, and Chromium's built-in DevTools reverse-proxied — the terminal Fitting's split-pane iframes its canvas, and any browser on the Tailnet can drive it directly."
  },
  voice: {
    role: "Speech I/O the Operative and channels can use for voice in and voice out.",
    fit: "Default Fitting proxies Deepgram speech-to-text and text-to-speech on its own port (default 7085) and provides a kind:voice capability. The web channel consumes it for push-to-talk recording and read-aloud replies; the API key stays server-side."
  }
};

export function FacultyStation({ facultyId }: { facultyId: FacultyId }) {
  const {
    composition,
    library,
    runnerState,
    saveComposition,
    busy,
    openFittingEditor
  } = useAppShell();

  const faculty = useMemo(() => faculties.find((f) => f.id === facultyId), [facultyId]);
  const previousFaculty = useMemo(() => {
    if (!faculty) return null;
    return faculties.find((f) => f.order === faculty.order - 1) ?? null;
  }, [faculty]);
  const nextFaculty = useMemo(() => {
    if (!faculty) return null;
    return faculties.find((f) => f.order === faculty.order + 1) ?? null;
  }, [faculty]);

  if (!faculty) {
    return (
      <main>
        <div className="page narrow">
          <div className="head">
            <h1>Unknown Faculty</h1>
            <p className="ld">No Faculty named &quot;{facultyId}&quot;.</p>
          </div>
          <Link className="btn ghost" href="/compose">
            ← Back to Overview
          </Link>
        </div>
      </main>
    );
  }

  if (!composition) {
    return (
      <main>
        <div className="page narrow">
          <div className="head">
            <h1>Loading…</h1>
          </div>
        </div>
      </main>
    );
  }

  const copy = facultyRoleCopy[faculty.id];
  const selections = composition.selections[faculty.id] ?? [];
  const entries = library.filter((e) => e.faculty === faculty.id);
  const verifyResults = runnerState?.verifyResults ?? [];
  const ownVerifies = verifyResults.filter((r) =>
    selections.some((s) => s.id === r.fittingId)
  );
  const verifyState =
    selections.length === 0
      ? "empty"
      : ownVerifies.length === 0
      ? "pending"
      : ownVerifies.every((r) => r.ok)
      ? "passed"
      : "failed";

  const isAlarm = faculty.id === "orchestrator" && selections.length === 0;

  function setSingleSelection(fittingId: string) {
    if (!composition) return;
    const selections = { ...composition.selections };
    const entry = library.find((e) => e.id === fittingId);
    if (!entry) {
      delete selections[faculty!.id];
    } else {
      selections[faculty!.id] = [defaultSelection(entry)];
    }
    void saveComposition({ selections });
  }

  function toggleMultiSelection(entry: LibraryEntry) {
    if (!composition) return;
    const current = composition.selections[faculty!.id] ?? [];
    const exists = current.some((s) => s.id === entry.id);
    const selections = { ...composition.selections };
    selections[faculty!.id] = exists
      ? current.filter((s) => s.id !== entry.id)
      : [...current, defaultSelection(entry)];
    if ((selections[faculty!.id]?.length ?? 0) === 0) {
      delete selections[faculty!.id];
    }
    void saveComposition({ selections });
  }

  function removeSelection(fittingId: string) {
    if (!composition) return;
    const current = composition.selections[faculty!.id] ?? [];
    const selections = { ...composition.selections };
    selections[faculty!.id] = current.filter((s) => s.id !== fittingId);
    if ((selections[faculty!.id]?.length ?? 0) === 0) {
      delete selections[faculty!.id];
    }
    void saveComposition({ selections });
  }

  function updateConfig(
    entry: LibraryEntry,
    key: string,
    value: string | number | boolean
  ) {
    if (!composition) return;
    const current = composition.selections[faculty!.id] ?? [];
    const selections = { ...composition.selections };
    selections[faculty!.id] = current.map((s) =>
      s.id === entry.id ? { ...s, config: { ...s.config, [key]: value } } : s
    );
    void saveComposition({ selections });
  }

  return (
    <main>
      <div className="crumbs">
        <Link href="/compose">Compose</Link> · <b>{faculty.name}</b>
      </div>
      <div className="page narrow">
        <header style={{ padding: "8px 0 22px", borderBottom: "1px solid var(--rule)", marginBottom: 26 }}>
          <div
            className="font-mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: isAlarm ? "var(--alarm)" : "var(--brass)",
              marginBottom: 6
            }}
          >
            Station {String(faculty.order).padStart(2, "0")} ·{" "}
            {faculty.cardinality} {faculty.cardinality === "single" ? "Faculty" : "Faculty"}
            {faculty.governing ? " · capstone" : ""}
            {isAlarm ? " · alarm" : ""}
          </div>
          <h1
            className="font-display"
            style={{ fontWeight: 600, fontSize: 40, letterSpacing: "-0.014em", lineHeight: 1.04, margin: "0 0 12px" }}
          >
            {faculty.name}
          </h1>
          <p
            className="font-display"
            style={{ fontSize: 18, lineHeight: 1.5, color: "var(--ink-mute)", margin: "0 0 14px", maxWidth: 640 }}
          >
            {copy.role}
          </p>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--mute)", maxWidth: 640, margin: 0 }}>
            {copy.fit}
          </p>
        </header>

        {isAlarm ? (
          <div className="banner alarm">
            <span className="glyph">!</span>
            <div>
              <h5>This station is empty — the Operative is running on a stub</h5>
              <p>
                v1 of Garrison ships without a reference Orchestrator Fitting. Until the Runtime SDK
                milestone lands one, the runner concatenates a minimal default. See{" "}
                <code>fittings/seed/README.md</code>.
              </p>
            </div>
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 1,
            background: "var(--rule)",
            border: "1px solid var(--rule)",
            marginBottom: isAlarm ? 28 : 32
          }}
        >
          <Cell label="Cardinality">
            {faculty.cardinality}
            {faculty.cardinality === "single" && faculty.governing ? (
              <strong style={{ color: "var(--alarm)", marginLeft: 6 }}> · required</strong>
            ) : null}
          </Cell>
          <Cell label="Shapes" mono>
            {faculty.shapes.join(" / ")}
          </Cell>
          <Cell label="Selected">
            {selections.length === 0 ? "—" : `${selections.length} fitting${selections.length === 1 ? "" : "s"}`}
          </Cell>
          <Cell
            label="Verify"
            tone={
              verifyState === "passed" ? "ok" : verifyState === "failed" ? "alarm" : "default"
            }
          >
            {verifyState}
          </Cell>
        </div>

        <div className="lab first">
          Fittings · {selections.length} selected of {entries.length} available
        </div>

        {entries.length === 0 ? (
          <div
            style={{
              border: "1px dashed var(--rule-2)",
              background: "var(--paper-2)",
              padding: "26px 24px",
              textAlign: "center"
            }}
          >
            <div className="font-display" style={{ fontWeight: 600, fontSize: 18, marginBottom: 4 }}>
              No Fittings curated for this Faculty yet
            </div>
            <p style={{ color: "var(--mute)", fontSize: 13, margin: "0 0 14px" }}>
              The registry doesn&apos;t have an entry for {faculty.name} in v1. Add one through{" "}
              <code>CONTRIBUTING.md</code> or check the Armory for community submissions.
            </p>
            <Link className="btn ghost small" href="/armory">
              Open Armory →
            </Link>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {entries.map((entry) => {
              const selection = selections.find((s) => s.id === entry.id);
              const selected = Boolean(selection);
              return (
                <FittingCard
                  key={entry.id}
                  entry={entry}
                  selected={selected}
                  cardinality={faculty.cardinality}
                  busy={busy === "save"}
                  composition={composition}
                  library={library}
                  onSelect={() =>
                    faculty.cardinality === "single"
                      ? setSingleSelection(selected ? "" : entry.id)
                      : toggleMultiSelection(entry)
                  }
                  onRemove={() => removeSelection(entry.id)}
                  onEdit={() => openFittingEditor(entry)}
                />
              );
            })}
          </div>
        )}

        {selections.map((selection) => {
          const entry = library.find((e) => e.id === selection.id);
          if (!entry) return null;
          return (
            <FittingConfigSection
              key={entry.id}
              entry={entry}
              selection={selection}
              updateConfig={updateConfig}
            />
          );
        })}

        {faculty.id === "orchestrator" ? (
          <OrchestratorGlobalConfig
            globalConfig={composition.globalConfig}
            onChange={(globalConfig) => void saveComposition({ globalConfig })}
            busy={busy}
          />
        ) : null}

        {selections.length > 0 ? (
          <div className="lab">Verify hooks</div>
        ) : null}
        {selections.length > 0 ? (
          <div style={{ display: "grid", gap: 6 }}>
            {selections.map((sel) => {
              const result = verifyResults.find((r) => r.fittingId === sel.id);
              const entry = library.find((e) => e.id === sel.id);
              return (
                <div
                  key={sel.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "100px 1fr auto",
                    gap: 12,
                    alignItems: "center",
                    padding: "10px 14px",
                    background: "white",
                    border: "1px solid var(--rule)",
                    fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                    fontSize: 11.5
                  }}
                >
                  <span style={{ color: result?.ok ? "var(--sage)" : result ? "var(--alarm)" : "var(--mute)", fontWeight: 600 }}>
                    {result?.ok ? "• passed" : result ? "! failed" : "· pending"}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <span style={{ color: "var(--mute)" }}>{entry?.name ?? sel.id} · </span>
                    {entry?.metadata.verify.command ?? ""}
                  </span>
                  <span style={{ color: "var(--mute)" }}>
                    {result?.durationMs !== undefined ? `${result.durationMs}ms` : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}

        <nav
          style={{
            marginTop: 40,
            paddingTop: 18,
            borderTop: "1px solid var(--rule)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 13
          }}
        >
          {previousFaculty ? (
            <Link
              href={`/compose/${previousFaculty.id}`}
              style={{
                textDecoration: "none",
                color: "var(--ink)",
                display: "flex",
                flexDirection: "column",
                gap: 2
              }}
            >
              <div
                className="font-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--mute)"
                }}
              >
                ← Previous station
              </div>
              <div className="font-display" style={{ fontWeight: 600, fontSize: 15 }}>
                {String(previousFaculty.order).padStart(2, "0")} · {previousFaculty.name}
              </div>
            </Link>
          ) : (
            <div />
          )}
          {nextFaculty ? (
            <Link
              href={`/compose/${nextFaculty.id}`}
              style={{
                textDecoration: "none",
                color: "var(--ink)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
                textAlign: "right"
              }}
            >
              <div
                className="font-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--mute)"
                }}
              >
                Next station →
              </div>
              <div className="font-display" style={{ fontWeight: 600, fontSize: 15 }}>
                {String(nextFaculty.order).padStart(2, "0")} · {nextFaculty.name}
              </div>
            </Link>
          ) : (
            <Link
              href="/compose"
              style={{
                textDecoration: "none",
                color: "var(--ink)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
                textAlign: "right"
              }}
            >
              <div
                className="font-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--mute)"
                }}
              >
                Back to overview
              </div>
              <div className="font-display" style={{ fontWeight: 600, fontSize: 15 }}>
                All stations
              </div>
            </Link>
          )}
        </nav>
      </div>
    </main>
  );
}

function Cell({
  label,
  children,
  tone,
  mono
}: {
  label: string;
  children: React.ReactNode;
  tone?: "ok" | "alarm" | "default";
  mono?: boolean;
}) {
  return (
    <div style={{ background: "white", padding: "12px 16px" }}>
      <div
        className="font-mono"
        style={{
          fontSize: 9.5,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--mute)",
          marginBottom: 4
        }}
      >
        {label}
      </div>
      <div
        className={mono ? "font-mono" : undefined}
        style={{
          fontSize: mono ? 12 : 13,
          fontWeight: 500,
          color: tone === "ok" ? "var(--sage)" : tone === "alarm" ? "var(--alarm)" : "var(--ink)"
        }}
      >
        {children}
      </div>
    </div>
  );
}

function FittingCard({
  entry,
  selected,
  cardinality,
  busy,
  composition,
  library,
  onSelect,
  onRemove,
  onEdit
}: {
  entry: LibraryEntry;
  selected: boolean;
  cardinality: "single" | "multi";
  busy: boolean;
  composition: Composition | null;
  library: LibraryEntry[];
  onSelect: () => void;
  onRemove: () => void;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <article
      style={{
        border: `1px solid ${selected ? "var(--sage)" : "var(--rule)"}`,
        background: selected ? "var(--sage-soft)" : "white",
        padding: "16px 18px"
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: 18,
          alignItems: "center"
        }}
      >
        <div>
          <div className="font-display" style={{ fontWeight: 600, fontSize: 16, letterSpacing: "-0.005em" }}>
            {entry.name}
            <span
              className="font-mono"
              style={{
                marginLeft: 8,
                fontSize: 10,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--mute)",
                border: "1px solid var(--rule)",
                padding: "2px 6px",
                background: "var(--paper)",
                fontWeight: 500,
                verticalAlign: "middle"
              }}
            >
              {entry.metadata.component_shape}
            </span>
          </div>
          <p style={{ color: "var(--mute)", fontSize: 13, lineHeight: 1.5, marginTop: 4, maxWidth: 540 }}>
            {entry.summary}
          </p>
          <div
            className="font-mono"
            style={{
              marginTop: 8,
              fontSize: 10.5,
              color: "var(--mute)",
              letterSpacing: "0.04em",
              display: "flex",
              gap: 14,
              flexWrap: "wrap"
            }}
          >
            <span>RATING · {entry.ratings.claude_code ?? "—"} cc · {entry.ratings.global ?? "—"} global</span>
            {entry.metadata.consumes.length > 0 ? (
              <span>CONSUMES · {entry.metadata.consumes.map((c) => c.kind).join(", ")}</span>
            ) : null}
            {entry.metadata.provides.length > 0 ? (
              <span>PROVIDES · {entry.metadata.provides.map((p) => p.kind).join(", ")}</span>
            ) : null}
            <span>SOURCE · {entry.localPath ?? entry.repo}</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
          {selected ? (
            <>
              <span
                className="font-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--sage)",
                  border: "1px solid var(--sage)",
                  padding: "3px 8px"
                }}
              >
                selected
              </span>
              {cardinality === "multi" ? (
                <button className="btn small ghost" onClick={onRemove} disabled={busy}>
                  Remove
                </button>
              ) : null}
              {entry.localPath ? (
                <button className="btn small ghost" onClick={onEdit}>
                  Edit files
                </button>
              ) : null}
            </>
          ) : (
            <>
              <button className="btn small primary" onClick={onSelect} disabled={busy}>
                + Add
              </button>
              {entry.localPath ? (
                <button className="btn small ghost" onClick={onEdit}>
                  Edit files
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--rule)", display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          className="btn small ghost"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{ flexShrink: 0 }}
        >
          {open ? "Less" : "Details"}
        </button>
        <Link
          href={`/fitting/${entry.id}`}
          className="font-mono"
          style={{
            fontSize: 10.5,
            color: "var(--mute)",
            letterSpacing: "0.04em",
            textDecoration: "none"
          }}
        >
          Open fitting page →
        </Link>
      </div>
      {open ? (
        <div style={{ marginTop: 4 }}>
          <FittingOverview entry={entry} composition={composition} library={library} compact />
        </div>
      ) : null}
    </article>
  );
}

function FittingConfigSection({
  entry,
  selection,
  updateConfig
}: {
  entry: LibraryEntry;
  selection: SelectedFitting;
  updateConfig: (entry: LibraryEntry, key: string, value: string | number | boolean) => void;
}) {
  // Faculty-tab views are the v2 equivalent of v1's ui.extension. v1 manifests
  // are normalized into a single { id: "main", placement: "faculty-tab" } view
  // by parseGarrisonMetadata, so this resolver path covers both.
  const facultyTabView = entry.metadata.ui
    ? matchView(entry.metadata.ui.views, "/", "faculty-tab")?.view ?? null
    : null;
  if (entry.metadata.config_schema.length === 0 && !facultyTabView) return null;
  return (
    <>
      {entry.metadata.config_schema.length > 0 ? (
        <>
          <div className="lab">Configure · {entry.name}</div>
          <div
            style={{
              border: "1px solid var(--rule)",
              background: "white",
              padding: "4px 18px"
            }}
          >
            {entry.metadata.config_schema.map((field) => (
              <ConfigInput
                key={field.key}
                field={field}
                value={selection.config[field.key] ?? field.default ?? ""}
                onChange={(value) => updateConfig(entry, field.key, value)}
              />
            ))}
          </div>
        </>
      ) : null}

      {facultyTabView ? (
        <>
          <div className="lab">Extension · {entry.name}</div>
          <div
            style={{
              border: "1px solid var(--rule)",
              background: "var(--paper-2)",
              padding: "16px 18px"
            }}
          >
            <div
              className="font-mono"
              style={{
                fontSize: 11,
                color: "var(--mute)",
                marginBottom: 10
              }}
            >
              x-garrison.ui.views[{facultyTabView.id}] · {facultyTabView.entry}
            </div>
            <FittingView entry={entry} selection={selection} view={facultyTabView} />
          </div>
        </>
      ) : null}
    </>
  );
}

function ConfigInput({
  field,
  value,
  onChange
}: {
  field: ConfigSchemaField;
  value: string | number | boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  if (field.type === "boolean") {
    return (
      <div className="field">
        <label>{field.key}</label>
        <label
          style={{ display: "flex", alignItems: "center", gap: 8, padding: 0, border: "none" }}
        >
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span style={{ fontSize: 12.5 }}>{value ? "true" : "false"}</span>
        </label>
        {field.description ? <div className="hint">{field.description}</div> : null}
      </div>
    );
  }
  if (field.type === "select") {
    return (
      <div className="field">
        <label>{field.key}</label>
        <select className="text" value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {field.description ? <div className="hint">{field.description}</div> : null}
      </div>
    );
  }
  const numeric = field.type === "integer" || field.type === "number";
  return (
    <div className="field">
      <label>{field.key}</label>
      <input
        className="text"
        type={numeric ? "number" : "text"}
        value={String(value)}
        onChange={(e) => onChange(numeric ? Number(e.target.value) : e.target.value)}
      />
      {field.description ? <div className="hint">{field.description}</div> : null}
    </div>
  );
}

function OrchestratorGlobalConfig({
  globalConfig,
  onChange,
  busy
}: {
  globalConfig: GlobalConfig;
  onChange: (g: GlobalConfig) => void;
  busy: string | null;
}) {
  return (
    <>
      <div className="lab">Global config · owned by the Orchestrator</div>
      <div style={{ border: "1px solid var(--rule)", background: "white", padding: "4px 18px" }}>
        <div className="field">
          <label>projects_root</label>
          <input
            className="text"
            value={globalConfig.projects_root}
            onChange={(e) =>
              onChange({ ...globalConfig, projects_root: e.target.value })
            }
            disabled={Boolean(busy)}
          />
          <div className="hint">Where the Operative goes to work on projects.</div>
        </div>
        <div className="field">
          <label>permissions_mode</label>
          <select
            className="text"
            value={globalConfig.permissions_mode}
            onChange={(e) =>
              onChange({
                ...globalConfig,
                permissions_mode: e.target.value as GlobalConfig["permissions_mode"]
              })
            }
            disabled={Boolean(busy)}
          >
            <option value="full-auto">full-auto</option>
            <option value="auto">auto</option>
            <option value="allow-file-edits">allow-file-edits</option>
            <option value="conservative">conservative</option>
          </select>
          <div className="hint">How aggressively the Operative is allowed to act.</div>
        </div>
        <div className="field">
          <label>guardrails.max_tasks_per_tick</label>
          <input
            className="text"
            type="number"
            value={globalConfig.guardrails.max_tasks_per_tick}
            onChange={(e) =>
              onChange({
                ...globalConfig,
                guardrails: {
                  ...globalConfig.guardrails,
                  max_tasks_per_tick: Number(e.target.value)
                }
              })
            }
            disabled={Boolean(busy)}
          />
        </div>
        <div className="field">
          <label>guardrails.max_tool_calls_per_tick</label>
          <input
            className="text"
            type="number"
            value={globalConfig.guardrails.max_tool_calls_per_tick}
            onChange={(e) =>
              onChange({
                ...globalConfig,
                guardrails: {
                  ...globalConfig.guardrails,
                  max_tool_calls_per_tick: Number(e.target.value)
                }
              })
            }
            disabled={Boolean(busy)}
          />
        </div>
        <div className="field">
          <label>guardrails.max_spend_per_day</label>
          <input
            className="text"
            type="number"
            step="0.01"
            value={globalConfig.guardrails.max_spend_per_day}
            onChange={(e) =>
              onChange({
                ...globalConfig,
                guardrails: {
                  ...globalConfig.guardrails,
                  max_spend_per_day: Number(e.target.value)
                }
              })
            }
            disabled={Boolean(busy)}
          />
        </div>
      </div>
    </>
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
