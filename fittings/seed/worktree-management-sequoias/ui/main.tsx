import React, { useCallback, useEffect, useMemo, useState } from "react";
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

interface Project { name: string; path: string; }

const LS_LAST_PROJECT = "garrison.worktrees.lastProject";

const CLAUDE_START_CMD =
  `claude 'Run the app on app.port and if there is a backend run it on backend.port. If any of these files does not exist create them with a random port number between 5000 and 9999. Also, update the respective env files to update the ports for the backend if it exists and the nextjs url if its a nextjs app. Run them on dev mode.'`;

const CLAUDE_CONTINUE_CMD =
  `claude --continue 'Run the app on app.port and if there is a backend run it on backend.port. If any of these files does not exist create them with a random port number between 5000 and 9999. Also, update the respective env files to update the ports for the backend if it exists and the nextjs url if its a nextjs app. Run them on dev mode.'`;

function buildTerminalUrl(terminalUrl: string, cwd: string, command?: string, name?: string): string {
  const u = new URL(terminalUrl);
  // The status file always writes 127.0.0.1 / localhost. Rewrite to the host
  // this page is being viewed at, so the link works on mobile / Tailscale too.
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
    u.hostname = window.location.hostname;
  }
  if (cwd) u.searchParams.set("cwd", cwd);
  if (command) u.searchParams.set("command", command);
  if (name) u.searchParams.set("name", name);
  return u.toString();
}

function App() {
  const initialRepo = new URLSearchParams(window.location.search).get("repoPath") || "";
  const [devRoot, setDevRoot] = useState<string>("");
  const [devRootDraft, setDevRootDraft] = useState<string>("");
  const [editingDevRoot, setEditingDevRoot] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [repoPath, setRepoPath] = useState<string>(
    initialRepo || localStorage.getItem(LS_LAST_PROJECT) || ""
  );
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyPrId, setBusyPrId] = useState<string | null>(null);
  const [terminalUrl, setTerminalUrl] = useState<string | null>(null);

  // Load dev root + projects on mount
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/dev-root").then((res) => res.json());
        if (typeof r.devRoot === "string") {
          setDevRoot(r.devRoot);
          setDevRootDraft(r.devRoot);
        }
      } catch {}
      try {
        const p = await fetch("/projects").then((res) => res.json());
        if (Array.isArray(p.projects)) setProjects(p.projects);
      } catch {}
      try {
        const t = await fetch("/terminal-target").then((res) => res.ok ? res.json() : null);
        if (t && typeof t.url === "string") setTerminalUrl(t.url);
      } catch {}
    })();
  }, []);

  // Periodically refresh terminal URL (in case terminal restarts on a new port)
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const t = await fetch("/terminal-target").then((res) => res.ok ? res.json() : null);
        if (t && typeof t.url === "string") setTerminalUrl(t.url);
        else setTerminalUrl(null);
      } catch { setTerminalUrl(null); }
    }, 15000);
    return () => clearInterval(id);
  }, []);

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

  useEffect(() => { if (repoPath) void refresh(); }, [repoPath]);

  async function reloadProjects(root?: string) {
    const qs = root ? `?devRoot=${encodeURIComponent(root)}` : "";
    try {
      const r = await fetch(`/projects${qs}`).then((res) => res.json());
      if (Array.isArray(r.projects)) setProjects(r.projects);
    } catch {}
  }

  async function saveDevRoot() {
    const target = devRootDraft.trim();
    if (!target) { setEditingDevRoot(false); return; }
    setError(null);
    try {
      const res = await fetch("/dev-root", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devRoot: target })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `HTTP ${res.status}`);
        return;
      }
      setDevRoot(data.devRoot);
      setEditingDevRoot(false);
      await reloadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function pickProject(p: string) {
    setRepoPath(p);
    if (p) localStorage.setItem(LS_LAST_PROJECT, p);
  }

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

  async function createPr(w: Worktree) {
    if (!w.id) return;
    const defaultTitle = w.title || w.branch;
    const titleInput = prompt(
      `Create PR for ${w.branch} → ${w.baseBranch || "main"}\n\nPR title (blank = use first commit):`,
      defaultTitle
    );
    if (titleInput === null) return;
    const draft = confirm("Open as a draft PR?\n\nOK = draft, Cancel = ready for review");
    setError(null);
    setBusyPrId(w.id);
    try {
      const res = await fetch(`/worktrees/${encodeURIComponent(w.id)}/pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: titleInput.trim(), draft })
      });
      const data = await res.json();
      if (!res.ok || !data?.url) {
        const trace = Array.isArray(data?.trace) ? `\n\n${data.trace.join("\n")}` : "";
        setError(`${data?.error ?? `HTTP ${res.status}`}${trace}`);
        return;
      }
      window.open(data.url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPrId(null);
    }
  }

  function openInTerminal(cwd: string, command?: string, name?: string) {
    if (!terminalUrl) {
      setError("Terminal fitting is not running. Start terminal-armory-default.");
      return;
    }
    const target = buildTerminalUrl(terminalUrl, cwd, command, name);
    window.location.href = target;
  }

  const projectOptions = useMemo(() => {
    const opts = [...projects];
    if (repoPath && !opts.find((p) => p.path === repoPath)) {
      opts.unshift({ name: repoPath.split("/").filter(Boolean).pop() || repoPath, path: repoPath });
    }
    return opts;
  }, [projects, repoPath]);

  return (
    <div className="app">
      <div>
        <h1>Garrison Worktrees</h1>
        <p className="subtitle">git worktree lifecycle. Writes session records into ~/.garrison/sessions/state.json.</p>
      </div>

      <div className="form">
        <div className="form-row">
          <label>Project</label>
          <select
            value={repoPath}
            onChange={(e) => pickProject(e.target.value)}
            style={{ flex: 1, minWidth: 240 }}
          >
            <option value="">— select a project —</option>
            {projectOptions.map((p) => (
              <option key={p.path} value={p.path}>{p.name} — {p.path}</option>
            ))}
          </select>
          <button type="button" className="btn" onClick={() => void refresh()} disabled={loading || !repoPath.trim()}>
            {loading ? "…" : "Refresh"}
          </button>
        </div>
        <div className="form-row">
          <label>Dev root</label>
          {editingDevRoot ? (
            <>
              <input
                value={devRootDraft}
                onChange={(e) => setDevRootDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveDevRoot();
                  if (e.key === "Escape") { setDevRootDraft(devRoot); setEditingDevRoot(false); }
                }}
                placeholder="/Users/you/dev"
                autoFocus
              />
              <button type="button" className="btn primary" onClick={() => void saveDevRoot()}>OK</button>
              <button type="button" className="btn" onClick={() => { setDevRootDraft(devRoot); setEditingDevRoot(false); }}>Esc</button>
            </>
          ) : (
            <>
              <code style={{ flex: 1, minWidth: 200 }} onClick={() => setEditingDevRoot(true)} title="click to edit">{devRoot || "(not set)"}</code>
              <button type="button" className="btn" onClick={() => setEditingDevRoot(true)}>Edit</button>
              <button type="button" className="btn" onClick={() => void reloadProjects()}>Rescan</button>
            </>
          )}
        </div>
        <div className="form-row">
          <label>New branch</label>
          <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/my-feature" />
          <label style={{ minWidth: 30 }}>Base</label>
          <input style={{ maxWidth: 140 }} value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="main" />
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

      {!terminalUrl && (
        <div className="hint">Terminal fitting unreachable — Claude Code / Terminal buttons will be disabled.</div>
      )}

      {projectPath && (
        <div className="strip">
          <span style={{ color: "var(--mute)", fontSize: 12 }}>
            {worktrees.length} worktree{worktrees.length === 1 ? "" : "s"} in <code>{projectPath}</code>
          </span>
        </div>
      )}

      {!projectPath ? (
        <div className="empty">Pick a project to see its worktrees.</div>
      ) : worktrees.length === 0 ? (
        <div className="empty">No worktrees yet for this repo.</div>
      ) : (
        <table className="simple">
          <thead>
            <tr>
              <th>Branch</th>
              <th>Path</th>
              <th>Status</th>
              <th>Created</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {worktrees.map((w) => (
              <tr key={w.path}>
                <td>
                  <code>{w.branch}</code>
                  {w.isMain && <span className="pill" style={{ marginLeft: 6 }}>main</span>}
                  {w.title && <span style={{ display: "block", color: "var(--mute)", fontSize: 11, marginTop: 4 }}>{w.title}</span>}
                </td>
                <td style={{ color: "var(--mute)" }}><code>{w.path}</code></td>
                <td><span className="pill">{w.lastStatus}</span></td>
                <td style={{ color: "var(--mute)" }}>{w.createdAt ?? "—"}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={!terminalUrl}
                    title="Open a terminal and start Claude with the run-the-app prompt"
                    onClick={() => openInTerminal(w.path, CLAUDE_START_CMD, `${w.branch}:claude`)}
                  >
                    Claude Code
                  </button>{" "}
                  <button
                    type="button"
                    className="btn"
                    disabled={!terminalUrl}
                    title="Open a terminal and continue Claude with the run-the-app prompt"
                    onClick={() => openInTerminal(w.path, CLAUDE_CONTINUE_CMD, `${w.branch}:cont`)}
                  >
                    Continue
                  </button>{" "}
                  <button
                    type="button"
                    className="btn"
                    disabled={!terminalUrl}
                    title="Open a plain terminal at this worktree"
                    onClick={() => openInTerminal(w.path, undefined, w.branch)}
                  >
                    Terminal
                  </button>{" "}
                  {w.id && !w.isMain && (
                    <>
                      <button
                        type="button"
                        className="btn"
                        title="Push the branch and open a PR via gh"
                        disabled={busyPrId === w.id}
                        onClick={() => void createPr(w)}
                      >
                        {busyPrId === w.id ? "Opening PR…" : "Create PR"}
                      </button>{" "}
                      <button type="button" className="btn danger" onClick={() => void remove(w.id!)}>Remove</button>
                    </>
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
