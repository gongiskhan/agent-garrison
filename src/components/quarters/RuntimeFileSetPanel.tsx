"use client";

// G5: the generic Quarters tier's directory-of-files surface (Cursor's
// rules/skills/agents/hooks/desktop settings/project rules, and any other
// runtime's file_sets entry). List -> pick -> edit, no Save button (autosave,
// matching every other Quarters surface); create/delete only where the
// descriptor allows it. Markdown entries get MarkdownEditor + read-only
// frontmatter chips (parsed server-side, shown for orientation - the raw
// content, frontmatter block included, is what actually saves); json entries
// get a plain textarea (Monaco is reserved for the single-file surfaces) with
// a merge note when the set writes by merge instead of replace.
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { MarkdownEditor } from "./MarkdownEditor";
import { useAutosave } from "@/hooks/useAutosave";

interface FileSetDecl {
  id: string;
  label: string;
  root: string;
  glob: string;
  format: "markdown" | "json";
  frontmatter?: string[];
  create?: boolean;
  write?: "replace" | "merge";
  platform?: string;
  scope?: "home" | "project";
  available: boolean;
  reason?: string;
  count?: number;
}

interface EntryRow {
  rel: string;
  bytes: number;
  mtime: string;
}

interface EntryView {
  rel: string;
  format: "markdown" | "json";
  exists: boolean;
  content: string;
  sha: string | null;
  frontmatter?: Record<string, unknown> | null;
  projected: boolean;
}

async function jsonOrThrow(r: Response) {
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? r.statusText);
  return j;
}

export function RuntimeFileSetPanel({ rid, setId }: { rid: string; setId: string }) {
  const [decl, setDecl] = useState<FileSetDecl | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState<string>("");
  const [entries, setEntries] = useState<EntryRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<EntryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const loadDecl = useCallback(async () => {
    try {
      const j = await jsonOrThrow(await fetch(`/api/quarters/runtime/${encodeURIComponent(rid)}/sets`));
      const found = (j.fileSets as FileSetDecl[]).find((f) => f.id === setId) ?? null;
      setDecl(found);
      setError(found ? null : `file set "${setId}" is not declared for ${rid}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [rid, setId]);

  useEffect(() => {
    void loadDecl();
  }, [loadDecl]);

  useEffect(() => {
    if (decl?.scope !== "project") return;
    fetch(`/api/quarters/runtime/${encodeURIComponent(rid)}/projects`)
      .then(jsonOrThrow)
      .then((j) => setProjects(j.projects as string[]))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [rid, decl?.scope]);

  const loadEntries = useCallback(async () => {
    if (!decl || !decl.available) return;
    if (decl.scope === "project" && !project) {
      setEntries([]);
      return;
    }
    try {
      const qs = decl.scope === "project" ? `?project=${encodeURIComponent(project)}` : "";
      const j = await jsonOrThrow(await fetch(`/api/quarters/runtime/${encodeURIComponent(rid)}/sets/${encodeURIComponent(setId)}${qs}`));
      setEntries(j.entries as EntryRow[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [rid, setId, decl, project]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const openEntry = useCallback(
    async (rel: string) => {
      setSelected(rel);
      try {
        const qs = new URLSearchParams({ rel, ...(project ? { project } : {}) });
        const j = await jsonOrThrow(
          await fetch(`/api/quarters/runtime/${encodeURIComponent(rid)}/sets/${encodeURIComponent(setId)}/file?${qs}`)
        );
        setView(j as EntryView);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [rid, setId, project]
  );

  const save = useCallback(
    async (content: string) => {
      if (!view) return;
      const j = await jsonOrThrow(
        await fetch(`/api/quarters/runtime/${encodeURIComponent(rid)}/sets/${encodeURIComponent(setId)}/file`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rel: view.rel, content, baselineSha: view.sha, ...(project ? { project } : {}) })
        })
      );
      setView(j as EntryView);
    },
    [rid, setId, view, project]
  );

  const { status, schedule, flush } = useAutosave<string>({ value: view?.content ?? "", onSave: save });

  const createFile = useCallback(async () => {
    if (!newName.trim()) return;
    try {
      const j = await jsonOrThrow(
        await fetch(`/api/quarters/runtime/${encodeURIComponent(rid)}/sets/${encodeURIComponent(setId)}/file`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rel: newName.trim(), content: "", ...(project ? { project } : {}) })
        })
      );
      setCreating(false);
      setNewName("");
      await loadEntries();
      setSelected(j.rel);
      setView(j as EntryView);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [rid, setId, newName, project, loadEntries]);

  const deleteFile = useCallback(async () => {
    if (!view) return;
    try {
      const qs = new URLSearchParams({ rel: view.rel, ...(project ? { project } : {}) });
      await jsonOrThrow(
        await fetch(`/api/quarters/runtime/${encodeURIComponent(rid)}/sets/${encodeURIComponent(setId)}/file?${qs}`, {
          method: "DELETE"
        })
      );
      setSelected(null);
      setView(null);
      await loadEntries();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [rid, setId, view, project, loadEntries]);

  if (!decl) return <div className="quarters-note">{error ?? "loading…"}</div>;
  if (!decl.available) {
    return (
      <div className="banner warn" data-testid="qs-unavailable">
        {decl.reason ?? `${decl.label} is not available on this node`}
      </div>
    );
  }

  return (
    <div className="runtime-file-set">
      {decl.scope === "project" && (
        <select
          className="qs-project-picker"
          data-testid="qs-project-picker"
          value={project}
          onChange={(e) => {
            setProject(e.target.value);
            setSelected(null);
            setView(null);
          }}
        >
          <option value="">Pick a project…</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      )}

      {error ? <div className="banner bad">{error}</div> : null}

      <div className="runtime-file-set-body">
        <ul className="runtime-file-set-list">
          {(entries ?? []).map((e) => (
            <li key={e.rel}>
              <button
                type="button"
                data-testid={`qs-entry-${e.rel}`}
                className={selected === e.rel ? "btn small" : "btn small ghost"}
                onClick={() => void openEntry(e.rel)}
              >
                {e.rel}
              </button>
            </li>
          ))}
          {entries && entries.length === 0 ? (
            <li className="quarters-note">
              {decl.scope === "project" && !project ? "Pick a project to see its files." : "No files here yet."}
            </li>
          ) : null}
        </ul>
        {decl.create ? (
          creating ? (
            <div className="runtime-file-set-create">
              <input
                data-testid="qs-create-name"
                placeholder={decl.format === "markdown" ? "new-rule.mdc" : "new.json"}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
              />
              <button type="button" className="btn small" data-testid="qs-create-save" onClick={() => void createFile()}>
                Create
              </button>
              <button type="button" className="btn small ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="btn small ghost" data-testid="qs-create" onClick={() => setCreating(true)}>
              <Plus size={14} /> New file
            </button>
          )
        ) : null}
      </div>

      {view ? (
        <div className="runtime-file-set-editor">
          <div className="runtime-file-head">
            <span className="runtime-file-path">{view.rel}</span>
            <span className="runtime-file-state">{status === "saving" ? "saving…" : status === "saved" ? "saved" : ""}</span>
            {decl.create ? (
              <button type="button" className="btn small ghost" data-testid="qs-delete" onClick={() => void deleteFile()}>
                <Trash2 size={14} /> Delete
              </button>
            ) : null}
          </div>
          {decl.write === "merge" ? (
            <div className="banner warn" data-testid="qs-merge-note">
              Saving here MERGES into the file - existing keys and array entries an operator hand-authored are kept, not
              replaced.
            </div>
          ) : null}
          {view.projected ? (
            <div className="banner warn">
              Garrison-managed projection — edit the source it is projected from, not this file; direct edits are refused
              server-side.
            </div>
          ) : null}
          {view.frontmatter ? (
            <div className="qs-frontmatter" data-testid="qs-frontmatter">
              {Object.entries(view.frontmatter).map(([k, v]) => (
                <span key={k} className="qs-frontmatter-chip">
                  {k}: {String(v)}
                </span>
              ))}
            </div>
          ) : null}
          {decl.format === "markdown" ? (
            <MarkdownEditor value={view.content} onSave={save} testId="qs-editor" />
          ) : (
            <textarea
              className="runtime-file-set-json"
              data-testid="qs-editor"
              value={view.content}
              disabled={view.projected}
              onChange={(e) => {
                setView({ ...view, content: e.target.value });
                schedule();
              }}
              onBlur={() => void flush()}
            />
          )}
        </div>
      ) : (
        <div className="quarters-note">Pick a file to edit it.</div>
      )}
    </div>
  );
}
