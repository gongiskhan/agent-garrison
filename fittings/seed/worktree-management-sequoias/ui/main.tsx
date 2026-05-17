import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

interface Worktree {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
  id: string | null;
  title: string | null;
  baseBranch: string | null;
  lastStatus: string;
  createdAt: string | null;
  status: string | null;
}

function App() {
  const initialRepo = new URLSearchParams(window.location.search).get("repoPath") || "";
  const [repoPath, setRepoPath] = useState(initialRepo);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (rp?: string) => {
    const target = (rp ?? repoPath).trim();
    if (!target) { setWorktrees([]); setProjectPath(null); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/worktrees?repoPath=${encodeURIComponent(target)}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `HTTP ${res.status}`);
        setWorktrees([]);
        setProjectPath(null);
      } else {
        setWorktrees(data.worktrees ?? []);
        setProjectPath(data.projectPath ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }, [repoPath]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function create() {
    if (!repoPath.trim() || !branch.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath: repoPath.trim(), branch: branch.trim(), baseBranch: baseBranch.trim() || "main", title: title.trim() || null })
      });
      const data = await res.json();
      if (!res.ok) setError(data?.error ?? `HTTP ${res.status}`);
      else { setBranch(""); setTitle(""); await refresh(); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm("Remove this worktree? (uses git worktree remove --force)")) return;
    try {
      const res = await fetch(`/worktrees/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) setError(data?.error ?? `HTTP ${res.status}`);
      else await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="app">
      <div>
        <h1>Garrison Worktrees</h1>
        <p className="subtitle">git worktree lifecycle. Writes session records into ~/.garrison/sessions/state.json.</p>
      </div>

      <div className="form">
        <div className="form-row">
          <label>Repo path</label>
          <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/Users/you/dev/myrepo" />
          <button type="button" className="btn" onClick={() => void refresh()} disabled={loading || !repoPath.trim()}>Load</button>
        </div>
        <div className="form-row">
          <label>Branch</label>
          <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/my-feature" />
          <label>Base</label>
          <input style={{ maxWidth: 120 }} value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="main" />
        </div>
        <div className="form-row">
          <label>Title (optional)</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="brief description" />
          <button type="button" className="btn primary" disabled={busy || !repoPath.trim() || !branch.trim()} onClick={create}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      {projectPath && (
        <div className="strip">
          <span style={{ color: "var(--mute)", fontSize: 12 }}>
            {worktrees.length} worktree{worktrees.length === 1 ? "" : "s"} in <code>{projectPath}</code>
          </span>
        </div>
      )}

      {!projectPath ? (
        <div className="empty">Enter a repo path and click Load.</div>
      ) : worktrees.length === 0 ? (
        <div className="empty">No worktrees yet for this repo.</div>
      ) : (
        <table className="simple">
          <thead>
            <tr><th>Branch</th><th>Path</th><th>Status</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            {worktrees.map((w) => (
              <tr key={w.path}>
                <td><code>{w.branch}</code>{w.isMain && <span className="pill" style={{ marginLeft: 6 }}>main</span>}</td>
                <td style={{ color: "var(--mute)" }}><code>{w.path}</code></td>
                <td><span className="pill">{w.lastStatus}</span></td>
                <td style={{ color: "var(--mute)" }}>{w.createdAt ?? "—"}</td>
                <td>
                  {w.id && !w.isMain && (
                    <button type="button" className="btn danger" onClick={() => void remove(w.id!)}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
