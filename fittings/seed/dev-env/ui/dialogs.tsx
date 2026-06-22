// Dialogs + toast for the Dev Env shell: New Worktree, Confirm Delete, and a
// transient bottom toast. Style follows the terminal donor's modal pattern.

import React, { useEffect, useState } from "react";
import { buildSessionRequest, MODE_OPTIONS, DEFAULT_MODE } from "./session-request";

interface Project {
  name: string;
  path: string;
}

export function NewWorktreeDialog({
  onClose,
  onCreated,
  onError,
  initialRepoPath
}: {
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  onError: (message: string) => void;
  initialRepoPath?: string;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [repoPath, setRepoPath] = useState<string>(initialRepoPath ?? "");
  const [branch, setBranch] = useState<string>("");
  const [baseBranch, setBaseBranch] = useState<string>("main");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/projects");
        const data = await res.json();
        if (Array.isArray(data.projects)) {
          setProjects(data.projects);
          if (data.projects.length > 0) {
            setRepoPath((prev) => prev || data.projects[0].path);
          }
        }
      } catch {}
    })();
  }, []);

  async function submit() {
    if (!repoPath || !branch.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath, branch: branch.trim(), baseBranch: baseBranch.trim() || "main" })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(data?.error ?? `HTTP ${res.status}`);
        return;
      }
      onCreated(String(data.id));
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New worktree</h2>
        <p className="modal-help">
          Creates <code>~/.worktrees/&lt;repo&gt;/&lt;branch&gt;</code>, starts a Claude and a
          shell terminal there, and opens the tab.
        </p>
        <label className="modal-label">
          Project
          <select
            className="project-picker"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.path} value={p.path}>{p.name}</option>
            ))}
            {repoPath && !projects.find((p) => p.path === repoPath) && (
              <option value={repoPath}>{repoPath}</option>
            )}
          </select>
        </label>
        <label className="modal-label">
          Branch
          <input
            autoFocus
            type="text"
            value={branch}
            placeholder="feat/my-change"
            onChange={(e) => setBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") onClose();
            }}
          />
        </label>
        <label className="modal-label">
          Base branch
          <input
            type="text"
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") onClose();
            }}
          />
        </label>
        <div className="modal-row">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || !branch.trim()}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

// "New session": pick a project (or type any absolute path) and get a full
// tab — session record + Claude PTY + shell PTY — without creating a worktree.
// With `resume`, the same picker instead launches `claude --continue`, resuming
// the most recent Claude conversation in the chosen directory.
export function StartSessionDialog({
  onClose,
  onCreated,
  onError,
  initialRepoPath,
  resume = false
}: {
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  onError: (message: string) => void;
  initialRepoPath?: string;
  resume?: boolean;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [path, setPath] = useState<string>(initialRepoPath ?? "");
  const [busy, setBusy] = useState(false);
  // Which face the session starts as (dev-env defaults to Joe). "off" = bare.
  const [mode, setMode] = useState<string>(DEFAULT_MODE);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/projects");
        const data = await res.json();
        if (Array.isArray(data.projects)) {
          setProjects(data.projects);
          if (data.projects.length > 0) {
            setPath((prev) => prev || data.projects[0].path);
          }
        }
      } catch {}
    })();
  }, []);

  async function submit() {
    if (!path.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSessionRequest({ path, resume, mode: resume ? null : mode }))
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(data?.error ?? `HTTP ${res.status}`);
        return;
      }
      onCreated(String(data.id));
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{resume ? "Continue session" : "New session"}</h2>
        <p className="modal-help">
          {resume ? (
            <>
              Opens a tab and resumes the most recent Claude conversation in the
              chosen project with <code>claude --continue</code>. No worktree is
              created.
            </>
          ) : (
            <>
              Opens a tab with a Claude and a shell terminal at the project root.
              No worktree is created.
            </>
          )}
        </p>
        <label className="modal-label">
          Project
          <select
            className="project-picker"
            value={projects.find((p) => p.path === path) ? path : ""}
            onChange={(e) => { if (e.target.value) setPath(e.target.value); }}
          >
            {projects.map((p) => (
              <option key={p.path} value={p.path}>{p.name}</option>
            ))}
            <option value="">custom path…</option>
          </select>
        </label>
        <label className="modal-label">
          Path
          <input
            type="text"
            value={path}
            placeholder="/Users/you/dev/project"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") onClose();
            }}
          />
        </label>
        {!resume && (
          <label className="modal-label">
            Orchestrator
            <select
              className="project-picker"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              {MODE_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
        )}
        <div className="modal-row">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || !path.trim()}>
            {busy ? (resume ? "Continuing…" : "Starting…") : (resume ? "Continue" : "Start")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDeleteDialog({
  label,
  detail,
  onClose,
  onConfirm
}: {
  label: string;
  detail: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Delete worktree</h2>
        <p className="modal-help">
          Removes the git worktree, its directory, the session record, and both
          terminals for <b>{label}</b>.
        </p>
        <p className="modal-help"><code>{detail}</code></p>
        <div className="modal-row">
          <button type="button" className="btn" onClick={onClose} autoFocus>Cancel</button>
          <button type="button" className="btn danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// Dev Env settings — tab-monitoring exclusions. One glob/segment pattern per
// line; cwds matching any line are kept out of the tab strip (and not
// auto-created from hooks). Server-persisted, so it applies across every
// client. Autosaves on edit (debounced) — no Save button, per the Garrison
// config convention; "Done" just closes.
export function SettingsDialog({
  onClose,
  onError
}: {
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState<string>("");
  const [defaults, setDefaults] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/settings/excludes");
        const data = await res.json();
        if (Array.isArray(data.patterns)) setText(data.patterns.join("\n"));
        if (Array.isArray(data.defaults)) setDefaults(data.defaults);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced autosave once the initial load has happened.
  useEffect(() => {
    if (!loaded) return;
    setSaveState("saving");
    const handle = window.setTimeout(() => { void save(text); }, 500);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, loaded]);

  async function save(value: string) {
    const patterns = value.split("\n").map((l) => l.trim()).filter(Boolean);
    try {
      const res = await fetch("/settings/excludes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patterns })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        onError(data?.error ?? `HTTP ${res.status}`);
        setSaveState("idle");
        return;
      }
      setSaveState("saved");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setSaveState("idle");
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <p className="modal-help">
          Tab exclusions — cwds matching any line stay out of the tab strip and
          aren't tracked from hooks. One pattern per line. <code>**</code>/<code>*</code>{" "}
          are globs; a plain word (e.g. <code>memory-compiler</code>) matches that
          path segment anywhere. A session with a live terminal here always shows,
          regardless. Changes save automatically.
        </p>
        <label className="modal-label">
          Excluded paths
          <textarea
            className="settings-textarea"
            spellCheck={false}
            value={text}
            placeholder={"**/fittings/**\nmemory-compiler\n.claude"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            rows={10}
          />
        </label>
        <div className="settings-foot">
          <span className="settings-status">
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
          </span>
          {defaults.length > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => setText(defaults.join("\n"))}
              title="Reset to the built-in default exclusions"
            >
              Reset to defaults
            </button>
          )}
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="toast">{message}</div>;
}
