// Dialogs + toast for the Dev Env shell: New Worktree, Confirm Delete, and a
// transient bottom toast. Style follows the terminal donor's modal pattern.

import React, { useEffect, useState } from "react";

interface Project {
  name: string;
  path: string;
}

export function NewWorktreeDialog({
  onClose,
  onCreated,
  onError
}: {
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  onError: (message: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [repoPath, setRepoPath] = useState<string>("");
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

// "Start session": pick a project (or type any absolute path) and get a full
// tab — session record + Claude PTY + shell PTY — without creating a worktree.
export function StartSessionDialog({
  onClose,
  onCreated,
  onError
}: {
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  onError: (message: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [path, setPath] = useState<string>("");
  const [busy, setBusy] = useState(false);

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
        body: JSON.stringify({ path: path.trim() })
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
        <h2>Start session</h2>
        <p className="modal-help">
          Opens a tab with a Claude and a shell terminal at the project root.
          No worktree is created.
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
        <div className="modal-row">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || !path.trim()}>
            {busy ? "Starting…" : "Start"}
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

export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="toast">{message}</div>;
}
