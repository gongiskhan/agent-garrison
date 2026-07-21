"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import clsx from "clsx";
import { useAppShell } from "@/components/chrome/AppShell";
import { AccountField, GenericLoginPanel } from "@/components/accounts/AccountField";
import { FittingView } from "@/components/fitting-views/FittingView";
import { FittingOverview } from "@/components/fitting-views/FittingOverview";
import { matchView } from "@/lib/fitting-views";
import { faculties, facultyRoleCopy } from "@/lib/faculties";
import type {
  Composition,
  ConfigSchemaField,
  FacultyDefinition,
  FacultyId,
  GlobalConfig,
  LibraryEntry,
  SelectedFitting
} from "@/lib/types";

export function FacultyStation({ facultyId }: { facultyId: FacultyId }) {
  const {
    composition,
    library,
    runnerState,
    saveComposition,
    refreshLibrary,
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

  // Clone a library Fitting into the local namespace. On success the registry
  // is refetched so the new copy appears as its own selectable card in the same
  // Faculty. Throws on failure so the card can surface the error inline.
  async function cloneEntry(entry: LibraryEntry): Promise<void> {
    const res = await fetch(`/api/fittings/${encodeURIComponent(entry.id)}/clone`, {
      method: "POST"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Clone failed (${res.status})`);
    await refreshLibrary();
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
        <header style={{ padding: "6px 0 18px", borderBottom: "1px solid var(--rule)", marginBottom: 22 }}>
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
            style={{
              fontWeight: 600,
              fontSize: "clamp(26px, 2.6vw, 34px)",
              letterSpacing: "-0.014em",
              lineHeight: 1.08,
              margin: "0 0 10px"
            }}
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
              <h5>Station empty — running on a stub</h5>
              <p>
                No reference Orchestrator Fitting ships in v1; the runner uses a minimal default. See{" "}
                <code>fittings/seed/README.md</code>.
              </p>
            </div>
          </div>
        ) : null}

        <div className="station-cells" style={{ marginBottom: isAlarm ? 28 : 32 }}>
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
              No Fittings curated for {faculty.name} yet
            </div>
            <p style={{ color: "var(--mute)", fontSize: 13, margin: "0 0 14px" }}>
              Add one through <code>CONTRIBUTING.md</code>, or search for Fittings in other Faculties.
            </p>
            <Link className="btn ghost small" href="/compose">
              Search all Fittings →
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
                  onClone={() => cloneEntry(entry)}
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
  onEdit,
  onClone
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
  onClone: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);

  async function handleClone() {
    if (cloning) return;
    setCloning(true);
    setCloneError(null);
    try {
      await onClone();
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : String(err));
    } finally {
      setCloning(false);
    }
  }
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
            {entry.cloned_from ? (
              <span
                className="font-mono"
                title={`Cloned from ${entry.cloned_from}`}
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--brass)",
                  border: "1px solid var(--brass)",
                  padding: "2px 6px",
                  fontWeight: 500,
                  verticalAlign: "middle"
                }}
              >
                clone
              </span>
            ) : null}
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
          {entry.localPath ? (
            <button
              className="btn small ghost"
              onClick={handleClone}
              disabled={cloning}
              title="Copy this Fitting into a local, editable copy"
            >
              {cloning ? "Cloning…" : "Clone"}
            </button>
          ) : null}
          {cloneError ? (
            <span style={{ fontSize: 10.5, color: "var(--alarm)", maxWidth: 180, textAlign: "right" }}>
              {cloneError}
            </span>
          ) : null}
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
  if (entry.metadata.config_schema.length === 0 && !facultyTabView && !entry.metadata.login) return null;
  return (
    <>
      {entry.metadata.config_schema.length > 0 || entry.metadata.login ? (
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
            {entry.metadata.login ? (
              <div className="field">
                <label>native login</label>
                <GenericLoginPanel fittingId={entry.id} storageHint={entry.metadata.login.storage_hint} />
              </div>
            ) : null}
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
  // RUNTIME-ACCOUNTS-V1: the "account" key renders as the account selector +
  // guided login flow instead of a free-text input (options are the registry,
  // which is dynamic — a static config_schema select cannot express it).
  if (field.key === "account") {
    return (
      <div className="field">
        <label>{field.key}</label>
        <AccountField value={String(value)} onChange={(next) => onChange(next)} />
        {field.description ? <div className="hint">{field.description}</div> : null}
      </div>
    );
  }
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
          <label>primary_runtime</label>
          <div className="hint">
            Set from the Muster Fittings tab&apos;s Primary picker now, not here.
            {globalConfig.primary_runtime ? (
              <>
                {" "}This composition still carries a deprecated value
                (&quot;{globalConfig.primary_runtime}&quot;); the policy file wins.
              </>
            ) : null}
          </div>
        </div>
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
