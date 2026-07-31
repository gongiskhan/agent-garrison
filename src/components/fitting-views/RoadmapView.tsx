"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FittingViewProps } from "@/components/fitting-views/registry";
import { usePersistedViewState } from "@/components/fitting-views/usePersistedViewState";
import type {
  KanbanTarget,
  Roadmap,
  RoadmapCategory,
  RoadmapItem,
  RoadmapOp
} from "@/lib/roadmaps";

interface ProjectRow {
  name: string;
  hasRoadmap: boolean;
}

interface RoadmapResponse {
  project: string;
  path: string;
  exists: boolean;
  roadmap: Roadmap | null;
}

interface KanbanConflict {
  itemId: string;
  list: KanbanTarget;
  alreadySent: KanbanTarget;
}

// The Roadmaps view: one roadmap.json per project, read and edited in place.
//
// Everything here writes through to the file on every change - there is no save
// button and no local draft, because agents edit the same file from other
// sessions and a client-held copy would go stale between one keystroke and the
// next. Text fields commit on blur (or Enter) rather than on a debounce timer:
// a commit tied to a real user event cannot be lost by an unmount.
export default function RoadmapView({ params }: FittingViewProps) {
  const deepLinkedProject = params.project ?? null;

  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [persisted, setPersisted, { loaded: persistedLoaded }] = usePersistedViewState<{
    project: string | null;
  }>("roadmaps", { project: null });
  const [project, setProject] = useState<string | null>(deepLinkedProject);
  const [data, setData] = useState<RoadmapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<KanbanConflict | null>(null);

  // ── project list + selection ──────────────────────────────────────────────

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/roadmaps/projects", { cache: "no-store" });
      const body = (await res.json()) as { projects?: ProjectRow[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setProjects(body.projects ?? []);
    } catch (err) {
      setProjects([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Pick a project once both the list and the remembered choice are in: an
  // explicit deep link wins, then the remembered one, then the first project
  // that actually has a roadmap.
  useEffect(() => {
    if (project || !projects || !persistedLoaded) return;
    const remembered = persisted.project;
    const candidate =
      (deepLinkedProject && projects.some((p) => p.name === deepLinkedProject)
        ? deepLinkedProject
        : null) ??
      (remembered && projects.some((p) => p.name === remembered) ? remembered : null) ??
      projects.find((p) => p.hasRoadmap)?.name ??
      null;
    if (candidate) setProject(candidate);
  }, [project, projects, persisted.project, persistedLoaded, deepLinkedProject]);

  const selectProject = useCallback(
    (name: string) => {
      setProject(name);
      setPersisted({ project: name });
      setData(null);
      setError(null);
      setNotice(null);
      setConflict(null);
    },
    [setPersisted]
  );

  // ── roadmap load ──────────────────────────────────────────────────────────

  const load = useCallback(async (name: string) => {
    try {
      const res = await fetch(`/api/roadmaps/${encodeURIComponent(name)}`, { cache: "no-store" });
      const body = (await res.json()) as RoadmapResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setData(body);
      setError(null);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (project) void load(project);
  }, [project, load]);

  // ── mutations ─────────────────────────────────────────────────────────────

  // Ticking a box is the one action a user repeats quickly, so it paints
  // immediately and the server's answer lands after. Every other operation
  // waits: they change structure, and guessing at the result would show ids
  // the server had not minted yet.
  const seq = useRef(0);
  const apply = useCallback(
    async (operation: RoadmapOp) => {
      if (!project) return;
      const optimistic = operation.op === "set-done";
      if (optimistic) {
        setData((current) =>
          current?.roadmap
            ? {
                ...current,
                roadmap: {
                  ...current.roadmap,
                  categories: current.roadmap.categories.map((category) => ({
                    ...category,
                    items: category.items.map((item) =>
                      item.id === operation.itemId ? { ...item, done: operation.done } : item
                    )
                  }))
                }
              }
            : current
        );
      } else {
        setBusy(true);
      }
      setNotice(null);
      const ticket = ++seq.current;
      try {
        const res = await fetch(`/api/roadmaps/${encodeURIComponent(project)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(operation)
        });
        const body = (await res.json()) as RoadmapResponse & { error?: string };
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        // A slower earlier response must not overwrite a newer state: the user
        // may have ticked three boxes while this one was in flight.
        if (ticket === seq.current) {
          setData(body);
          setError(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        // The file is the truth: on a failed write, re-read rather than leave
        // the screen showing an optimistic state that never landed.
        void load(project);
      } finally {
        if (!optimistic) setBusy(false);
      }
    },
    [project, load]
  );

  const createRoadmap = useCallback(async () => {
    if (!project) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/roadmaps/${encodeURIComponent(project)}`, { method: "POST" });
      const body = (await res.json()) as RoadmapResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setData(body);
      setError(null);
      setManage(true);
      void loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [project, loadProjects]);

  const sendToKanban = useCallback(
    async (itemId: string, list: KanbanTarget, force = false) => {
      if (!project) return;
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch(`/api/roadmaps/${encodeURIComponent(project)}/kanban`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId, list, force })
        });
        const body = (await res.json()) as {
          roadmap?: Roadmap;
          sent?: { list: KanbanTarget; cardId: string };
          error?: string;
          confirmRequired?: boolean;
          alreadySent?: KanbanTarget;
        };
        if (res.status === 409 && body.confirmRequired) {
          setConflict({ itemId, list, alreadySent: body.alreadySent ?? "backlog" });
          return;
        }
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        setConflict(null);
        if (body.roadmap && data) setData({ ...data, roadmap: body.roadmap });
        setNotice(
          `Card created on ${body.sent?.list === "todo" ? "To Do" : "Backlog"} (${body.sent?.cardId}).`
        );
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [project, data]
  );

  const roadmap = data?.exists ? data.roadmap : null;
  const noteIds = useMemo(
    () => new Set((roadmap?.notes ?? []).map((note) => note.id)),
    [roadmap]
  );

  return (
    <div style={{ display: "grid", gap: 20, width: "100%", minWidth: 0, maxWidth: 900 }}>
      <header style={{ borderLeft: "2px solid var(--brass)", paddingLeft: 18 }}>
        <div className="font-mono" style={eyebrowStyle}>
          Project planning
        </div>
        <div
          className="font-display"
          style={{ fontSize: 22, lineHeight: 1.15, letterSpacing: "-0.02em", fontWeight: 600 }}
        >
          Roadmaps
        </div>
        <div style={{ maxWidth: 640, fontSize: 13.5, lineHeight: 1.65, color: "var(--mute)", marginTop: 7 }}>
          One <code>roadmap.json</code> per project: categories, tasks, the
          decisions behind them, and a one-way bridge onto the Kanban board.
          Agents edit the same file from other sessions - this view reads it live.
        </div>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 9, alignItems: "center" }}>
        <label className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>
          Project
        </label>
        <select
          value={project ?? ""}
          onChange={(event) => selectProject(event.target.value)}
          disabled={projects === null}
          className="font-mono"
          style={selectStyle}
        >
          <option value="" disabled>
            {projects === null ? "Loading projects…" : "Choose a project"}
          </option>
          {(projects ?? []).map((row) => (
            <option key={row.name} value={row.name}>
              {row.name}
              {row.hasRoadmap ? "" : "  (no roadmap yet)"}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => project && void load(project)}
          disabled={!project || busy}
        >
          Refresh
        </button>
        {roadmap ? (
          <button
            type="button"
            className={manage ? primaryButtonClass : secondaryButtonClass}
            onClick={() => setManage((value) => !value)}
          >
            {manage ? "Done" : "Manage"}
          </button>
        ) : null}
      </div>

      {error ? <Notice title="Roadmap error" body={error} tone="bad" /> : null}
      {notice ? <Notice title="Sent to the board" body={notice} tone="info" /> : null}

      {project && data && !data.exists ? (
        <Panel title="No roadmap yet">
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--mute)", marginBottom: 12 }}>
            <b style={{ color: "var(--ink)" }}>{project}</b> has no{" "}
            <code>roadmap.json</code>. Create an empty one at{" "}
            <code style={{ overflowWrap: "anywhere" }}>{data.path}</code> and start
            adding categories - or let an agent write the file directly.
          </div>
          <button type="button" className={primaryButtonClass} onClick={createRoadmap} disabled={busy}>
            Create roadmap.json
          </button>
        </Panel>
      ) : null}

      {roadmap ? (
        <>
          <Panel
            title={
              roadmap.updatedAt
                ? `Updated ${new Date(roadmap.updatedAt).toLocaleString()}`
                : "Roadmap"
            }
          >
            {manage ? (
              <CommitInput
                value={roadmap.title}
                ariaLabel="Roadmap title"
                onCommit={(title) => void apply({ op: "set-title", title })}
                style={{ ...inputStyle, fontSize: 16, fontWeight: 600 }}
              />
            ) : (
              <div
                className="font-display"
                style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}
              >
                {roadmap.title}
              </div>
            )}
            <div className="font-mono" style={{ fontSize: 11, color: "var(--mute)", marginTop: 6, overflowWrap: "anywhere" }}>
              {data?.path}
            </div>
            {manage ? (
              <CommitTextarea
                value={roadmap.intro ?? ""}
                ariaLabel="Rule fixed at the top of the roadmap"
                placeholder="The rule fixed at the top of this roadmap (optional)"
                onCommit={(intro) => void apply({ op: "set-intro", intro })}
                rows={4}
                style={{ ...inputStyle, marginTop: 12 }}
              />
            ) : roadmap.intro ? (
              <div
                style={{
                  marginTop: 12,
                  borderLeft: "3px solid var(--brass)",
                  background: "var(--surface-strong)",
                  padding: "11px 14px",
                  fontSize: 13,
                  lineHeight: 1.65,
                  whiteSpace: "pre-wrap"
                }}
              >
                {roadmap.intro}
              </div>
            ) : null}
          </Panel>

          {roadmap.categories.map((category) => (
            <CategoryPanel
              key={category.id}
              category={category}
              manage={manage}
              busy={busy}
              noteIds={noteIds}
              conflict={conflict}
              onApply={apply}
              onSend={sendToKanban}
              onCancelConflict={() => setConflict(null)}
            />
          ))}

          {manage ? (
            <Panel title="Add a category">
              <AddRow
                placeholder="Category title"
                submitLabel="Add category"
                disabled={busy}
                onSubmit={(title) => void apply({ op: "add-category", title })}
              />
            </Panel>
          ) : null}

          {roadmap.categories.length === 0 && !manage ? (
            <EmptyState title="Empty roadmap">
              No categories yet. Hit Manage to add one, or ask an agent to fill
              the file in.
            </EmptyState>
          ) : null}

          {roadmap.notes.length > 0 ? (
            <section style={{ display: "grid", gap: 12 }}>
              <div className="font-mono" style={{ ...eyebrowStyle, marginTop: 8 }}>
                Notes
              </div>
              {roadmap.notes.map((note) => (
                <section
                  key={note.id}
                  id={note.id}
                  style={{
                    border: "1px solid var(--rule)",
                    borderLeft: "3px solid var(--brass)",
                    background: "var(--surface)",
                    padding: "14px 16px",
                    // Keep the anchored note clear of the sticky app chrome.
                    scrollMarginTop: 24
                  }}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                    <b style={{ fontSize: 14 }}>{note.title}</b>
                    <span className="font-mono" style={{ fontSize: 10.5, color: "var(--mute)" }}>
                      #{note.id}
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 13,
                      lineHeight: 1.7,
                      color: "var(--ink)",
                      whiteSpace: "pre-wrap"
                    }}
                  >
                    {note.body}
                  </div>
                </section>
              ))}
            </section>
          ) : null}
        </>
      ) : null}

      {project === null && projects !== null && projects.length === 0 ? (
        <EmptyState title="No projects found">
          Nothing under the dev root looks like a git repository. Point dev-env
          at the right directory and refresh.
        </EmptyState>
      ) : null}
    </div>
  );
}

// ── category ────────────────────────────────────────────────────────────────

function CategoryPanel({
  category,
  manage,
  busy,
  noteIds,
  conflict,
  onApply,
  onSend,
  onCancelConflict
}: {
  category: RoadmapCategory;
  manage: boolean;
  busy: boolean;
  noteIds: Set<string>;
  conflict: KanbanConflict | null;
  onApply: (operation: RoadmapOp) => void;
  onSend: (itemId: string, list: KanbanTarget, force?: boolean) => void;
  onCancelConflict: () => void;
}) {
  const done = category.items.filter((item) => item.done).length;
  return (
    <section
      id={category.id}
      style={{
        border: "1px solid var(--rule)",
        borderTop: "2px solid var(--brass)",
        background: "var(--surface)",
        padding: "16px 18px",
        scrollMarginTop: 24
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 12 }}>
        {manage ? (
          <CommitInput
            value={category.title}
            ariaLabel={`Title of category ${category.id}`}
            onCommit={(title) => onApply({ op: "edit-category", categoryId: category.id, title })}
            style={{ ...inputStyle, fontWeight: 600, flex: "1 1 220px" }}
          />
        ) : (
          <b style={{ fontSize: 15, letterSpacing: "-0.01em" }}>{category.title}</b>
        )}
        <span className="font-mono" style={{ fontSize: 10.5, color: "var(--mute)" }}>
          {category.id} · {done}/{category.items.length}
        </span>
        <AnchorLink noteRef={category.noteRef} noteIds={noteIds} />
        {manage ? (
          <ConfirmButton
            label="Delete category"
            confirmLabel="Delete it?"
            disabled={busy}
            onConfirm={() => onApply({ op: "delete-category", categoryId: category.id })}
          />
        ) : null}
      </div>

      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 4 }}>
        {category.items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            manage={manage}
            busy={busy}
            noteIds={noteIds}
            conflict={conflict?.itemId === item.id ? conflict : null}
            onApply={onApply}
            onSend={onSend}
            onCancelConflict={onCancelConflict}
          />
        ))}
      </ul>

      {manage ? (
        <div style={{ marginTop: 12 }}>
          <AddRow
            placeholder="New task"
            submitLabel="Add task"
            disabled={busy}
            onSubmit={(text) => onApply({ op: "add-item", categoryId: category.id, text })}
          />
        </div>
      ) : null}
    </section>
  );
}

// ── item ────────────────────────────────────────────────────────────────────

function ItemRow({
  item,
  manage,
  busy,
  noteIds,
  conflict,
  onApply,
  onSend,
  onCancelConflict
}: {
  item: RoadmapItem;
  manage: boolean;
  busy: boolean;
  noteIds: Set<string>;
  conflict: KanbanConflict | null;
  onApply: (operation: RoadmapOp) => void;
  onSend: (itemId: string, list: KanbanTarget, force?: boolean) => void;
  onCancelConflict: () => void;
}) {
  return (
    <li
      id={item.id}
      style={{
        display: "grid",
        gap: 4,
        padding: "7px 9px",
        background: item.done ? "transparent" : "var(--surface-strong)",
        borderLeft: `2px solid ${item.done ? "var(--rule-2)" : "var(--brass)"}`,
        scrollMarginTop: 24
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <input
          type="checkbox"
          checked={item.done}
          aria-label={`Mark "${item.text}" done`}
          onChange={(event) =>
            onApply({ op: "set-done", itemId: item.id, done: event.target.checked })
          }
          style={{ marginTop: 3, accentColor: "var(--sage)", cursor: "pointer" }}
        />
        {manage ? (
          <CommitInput
            value={item.text}
            ariaLabel={`Text of task ${item.id}`}
            onCommit={(text) => onApply({ op: "edit-item", itemId: item.id, text })}
            style={{ ...inputStyle, flex: "1 1 240px" }}
          />
        ) : (
          <span
            style={{
              flex: "1 1 240px",
              minWidth: 0,
              fontSize: 13,
              lineHeight: 1.55,
              color: item.done ? "var(--mute)" : "var(--ink)",
              textDecoration: item.done ? "line-through" : "none"
            }}
          >
            {item.text}
          </span>
        )}
        <span className="font-mono" style={{ fontSize: 10, color: "var(--mute)", marginTop: 3 }}>
          {item.id}
        </span>
        <AnchorLink noteRef={item.noteRef} noteIds={noteIds} />
      </div>

      {/* Quiet text actions rather than bordered buttons: they repeat on every
          row, and a page of forty outlined boxes reads as chrome, not content. */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", paddingLeft: 25 }}>
        <button
          type="button"
          className={sendActionClass}
          disabled={busy}
          onClick={() => onSend(item.id, "backlog")}
        >
          → Backlog
        </button>
        <button
          type="button"
          className={sendActionClass}
          disabled={busy}
          onClick={() => onSend(item.id, "todo")}
        >
          → To Do
        </button>
        {item.sentToKanban ? (
          <span className="font-mono" style={{ fontSize: 10, color: "var(--mute)" }}>
            sent to {item.sentToKanban === "todo" ? "To Do" : "Backlog"}
            {item.kanbanCardId ? ` · ${item.kanbanCardId}` : ""}
          </span>
        ) : null}
        {manage ? (
          <ConfirmButton
            label="Delete"
            confirmLabel="Delete it?"
            disabled={busy}
            onConfirm={() => onApply({ op: "delete-item", itemId: item.id })}
          />
        ) : null}
      </div>

      {conflict ? (
        <div
          role="alert"
          style={{
            marginLeft: 25,
            marginTop: 2,
            border: "1px solid var(--alarm)",
            background: "var(--alarm-soft)",
            padding: "8px 10px",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            fontSize: 12
          }}
        >
          <span>
            Already sent to {conflict.alreadySent === "todo" ? "To Do" : "Backlog"}. Send a
            second card?
          </span>
          <button
            type="button"
            className={tinyButtonClass}
            disabled={busy}
            onClick={() => onSend(conflict.itemId, conflict.list, true)}
          >
            Send again
          </button>
          <button type="button" className={tinyButtonClass} onClick={onCancelConflict}>
            Cancel
          </button>
        </div>
      ) : null}
    </li>
  );
}

// ── shared bits ─────────────────────────────────────────────────────────────

// Jump to the note holding this item's decisions. Scrolls rather than
// navigating: the view lives inside the app shell, and a raw hash link would
// push a history entry per click.
function AnchorLink({ noteRef, noteIds }: { noteRef: string | null; noteIds: Set<string> }) {
  if (!noteRef || !noteIds.has(noteRef)) return null;
  return (
    <a
      href={`#${noteRef}`}
      className="font-mono"
      style={{ fontSize: 10.5, color: "var(--brass)", textDecoration: "none", marginTop: 3 }}
      onClick={(event) => {
        event.preventDefault();
        document.getElementById(noteRef)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
    >
      notes ↓
    </a>
  );
}

// A text field that commits on blur or Enter and reverts on Escape. No
// debounce: a timer-based autosave can be cut short by an unmount, and this
// writes straight to a file another process may also be editing.
//
// A textarea sized to its content rather than an <input>: roadmap tasks run to
// two or three lines, and a single-line field would hide most of the sentence
// being edited behind a scroll position.
function CommitInput({
  value,
  ariaLabel,
  onCommit,
  style
}: {
  value: string;
  ariaLabel: string;
  onCommit: (next: string) => void;
  style?: React.CSSProperties;
}) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  const field = useRef<HTMLTextAreaElement | null>(null);

  const fit = useCallback(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, []);

  useEffect(() => {
    committed.current = value;
    setDraft(value);
  }, [value]);
  useEffect(() => {
    fit();
  }, [draft, fit]);

  const commit = () => {
    const next = draft.trim();
    if (!next || next === committed.current) {
      setDraft(committed.current);
      return;
    }
    onCommit(next);
  };

  return (
    <textarea
      ref={field}
      value={draft}
      rows={1}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        // Enter commits: these are one-sentence fields, so a newline in them is
        // a mistake far more often than an intent.
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(committed.current);
          event.currentTarget.blur();
        }
      }}
      style={{ ...style, resize: "none", overflow: "hidden", lineHeight: 1.55 }}
    />
  );
}

function CommitTextarea({
  value,
  ariaLabel,
  placeholder,
  onCommit,
  rows,
  style
}: {
  value: string;
  ariaLabel: string;
  placeholder?: string;
  onCommit: (next: string) => void;
  rows?: number;
  style?: React.CSSProperties;
}) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  useEffect(() => {
    committed.current = value;
    setDraft(value);
  }, [value]);
  return (
    <textarea
      value={draft}
      rows={rows}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === committed.current) return;
        onCommit(draft);
      }}
      style={{ ...style, resize: "vertical", lineHeight: 1.6 }}
    />
  );
}

function AddRow({
  placeholder,
  submitLabel,
  disabled,
  onSubmit
}: {
  placeholder: string;
  submitLabel: string;
  disabled: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const next = value.trim();
    if (!next) return;
    onSubmit(next);
    setValue("");
  };
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <input
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        style={{ ...inputStyle, flex: "1 1 240px" }}
      />
      <button
        type="button"
        className={secondaryButtonClass}
        onClick={submit}
        disabled={disabled || !value.trim()}
      >
        {submitLabel}
      </button>
    </div>
  );
}

// Two-step delete. A browser confirm() dialog is jarring inside an embedded
// view, and a one-click delete of a category takes its whole task list with it.
function ConfirmButton({
  label,
  confirmLabel,
  disabled,
  onConfirm
}: {
  label: string;
  confirmLabel: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={tinyButtonClass}
      disabled={disabled}
      style={armed ? { borderColor: "var(--alarm)", color: "var(--alarm)" } : undefined}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        border: "1px solid var(--rule)",
        borderTop: "2px solid var(--brass)",
        background: "var(--surface)",
        padding: "16px 18px"
      }}
    >
      <div className="font-mono" style={{ ...eyebrowStyle, marginBottom: 12 }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px dashed var(--rule-2)",
        borderLeft: "3px solid var(--brass)",
        background: "var(--surface-strong)",
        padding: "12px 14px",
        fontSize: 12.5,
        lineHeight: 1.6,
        color: "var(--mute)"
      }}
    >
      <b style={{ display: "block", marginBottom: 2, color: "var(--ink)" }}>{title}</b>
      {children}
    </div>
  );
}

function Notice({ title, body, tone }: { title: string; body?: string; tone?: "bad" | "info" }) {
  const bad = tone === "bad";
  return (
    <div
      style={{
        border: "1px solid var(--rule)",
        borderLeft: `3px solid ${bad ? "var(--alarm)" : "var(--brass)"}`,
        background: bad ? "var(--alarm-soft)" : "var(--surface)",
        padding: "11px 14px"
      }}
      role={bad ? "alert" : "status"}
      aria-live={bad ? "assertive" : "polite"}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: bad ? "var(--alarm)" : "var(--ink)" }}>
        {title}
      </div>
      {body ? (
        <div style={{ color: "var(--mute)", fontSize: 12.5, lineHeight: 1.55, marginTop: 4, overflowWrap: "anywhere" }}>
          {body}
        </div>
      ) : null}
    </div>
  );
}

const eyebrowStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "var(--brass)"
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  border: "1px solid var(--rule-2)",
  background: "var(--paper)",
  color: "var(--ink)",
  padding: "6px 9px",
  fontSize: 13,
  fontFamily: "inherit"
};

const selectStyle: React.CSSProperties = {
  border: "1px solid var(--rule-2)",
  background: "var(--paper)",
  color: "var(--ink)",
  padding: "7px 10px",
  fontSize: 12,
  minWidth: 220
};

const primaryButtonClass =
  "min-h-10 rounded-[4px] border border-[var(--sage)] bg-[var(--sage)] px-4 text-xs font-semibold text-[var(--paper)] transition hover:brightness-90 active:translate-y-px active:scale-[0.99] disabled:opacity-50";

const secondaryButtonClass =
  "min-h-10 rounded-[4px] border border-[var(--rule-2)] bg-[var(--surface)] px-4 text-xs font-semibold text-[var(--ink)] transition hover:border-[var(--brass)] hover:bg-[var(--paper-2)] active:translate-y-px active:scale-[0.99] disabled:opacity-50";

const sendActionClass =
  "-mx-1 rounded-[3px] px-1 py-0.5 font-mono text-[10.5px] text-[var(--mute)] transition hover:text-[var(--brass)] hover:underline focus-visible:text-[var(--brass)] active:translate-y-px disabled:opacity-50";

const tinyButtonClass =
  "rounded-[3px] border border-[var(--rule-2)] bg-[var(--surface)] px-2 py-1 font-mono text-[10.5px] text-[var(--ink)] transition hover:border-[var(--brass)] hover:bg-[var(--paper-2)] active:translate-y-px disabled:opacity-50";
