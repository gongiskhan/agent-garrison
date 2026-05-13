"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppShell } from "@/components/chrome/AppShell";
import { dispatchLaunchClaude } from "@/lib/workbench-bus";
import type { FittingViewProps } from "@/components/fitting-views/registry";

interface Worktree {
  worktreePath: string;
  branch: string;
  commit: string;
  isMain: boolean;
}

interface OutpostStatus {
  name: string;
  connected: boolean;
}

interface PrEntry {
  number: number;
  url: string;
  title: string;
  state: string;
}

const DEFAULT_DEV_ROOT = "~/dev";

export default function WorktreeView({ config }: FittingViewProps) {
  const seedProject = (config.repo_path as string | undefined) ?? "";
  const { composition, library } = useAppShell();

  const terminalInstalled = library.some(
    (e) =>
      e.faculty === "terminal" &&
      (composition?.selections[e.faculty] ?? []).some((s) => s.id === e.id)
  );

  // ── Machine selector ──────────────────────────────────────────────────────
  const [target, setTarget] = useState<string>("local");
  const [outposts, setOutposts] = useState<OutpostStatus[]>([]);

  // ── Project selector ──────────────────────────────────────────────────────
  const [projects, setProjects] = useState<string[]>([]);
  const [repoPath, setRepoPath] = useState<string>("");
  const [devRoot, setDevRoot] = useState<string>(DEFAULT_DEV_ROOT);
  const [editingDevRoot, setEditingDevRoot] = useState(false);
  const [devRootDraft, setDevRootDraft] = useState<string>(DEFAULT_DEV_ROOT);

  // ── Worktrees ──────────────────────────────────────────────────────────────
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [loading, setLoading] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [creatingPr, setCreatingPr] = useState<string | null>(null);
  const [prPopover, setPrPopover] = useState<string | null>(null);
  const [prList, setPrList] = useState<PrEntry[]>([]);
  const [prLoading, setPrLoading] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const [prefsLoaded, setPrefsLoaded] = useState(false);

  // ── Load preferences on mount ─────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/workbench/prefs");
        if (res.ok) {
          const prefs = (await res.json()) as {
            worktrees?: {
              lastTarget?: string;
              lastProjectByTarget?: Record<string, string>;
              devRootByTarget?: Record<string, string>;
            };
          };
          const wt = prefs.worktrees;
          if (wt) {
            const savedTarget = wt.lastTarget ?? "local";
            const savedDevRoot = wt.devRootByTarget?.[savedTarget] ?? DEFAULT_DEV_ROOT;
            const savedProject = wt.lastProjectByTarget?.[savedTarget] ?? seedProject;
            setTarget(savedTarget);
            setDevRoot(savedDevRoot);
            setDevRootDraft(savedDevRoot);
            if (savedProject) setRepoPath(savedProject);
          }
        }
      } catch {
        // ignore — fall through to defaults
      } finally {
        setPrefsLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Poll outposts every 3s ─────────────────────────────────────────────────
  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch("/api/workbench/outposts");
        const data = (await res.json()) as { outposts?: OutpostStatus[] };
        setOutposts(data.outposts ?? []);
      } catch {
        // outpost-host may not be running
      }
    }
    void poll();
    const id = setInterval(() => { void poll(); }, 3000);
    return () => clearInterval(id);
  }, []);

  // ── Load projects when target or devRoot changes (only after prefs are loaded) ──
  useEffect(() => {
    if (!prefsLoaded) return;
    setProjectsLoading(true);
    setProjects([]);
    void (async () => {
      try {
        const params = new URLSearchParams({ target, devRoot });
        const res = await fetch(`/api/workbench/projects?${params.toString()}`);
        const data = (await res.json()) as { projects?: string[]; error?: string };
        const list = data.projects ?? [];
        setProjects(list);
        setRepoPath((prev) => {
          if (prev && list.includes(prev)) return prev;
          return list[0] ?? "";
        });
      } catch {
        setProjects([]);
      } finally {
        setProjectsLoading(false);
      }
    })();
  }, [target, devRoot, prefsLoaded]);

  // ── Persist target + devRoot to prefs ─────────────────────────────────────
  function savePrefs(newTarget: string, newProject: string, newDevRoot: string) {
    void fetch("/api/workbench/prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        worktrees: {
          lastTarget: newTarget,
          lastProjectByTarget: { [newTarget]: newProject },
          devRootByTarget: { [newTarget]: newDevRoot },
        },
      }),
    });
  }

  function handleTargetChange(newTarget: string) {
    setTarget(newTarget);
    setWorktrees([]);
    setError(null);
    // devRoot and project will be restored from prefs on next projects-load effect;
    // preload from prefs already stored in the live pref state via a separate fetch
    void (async () => {
      try {
        const res = await fetch("/api/workbench/prefs");
        const prefs = (await res.json()) as {
          worktrees?: {
            devRootByTarget?: Record<string, string>;
            lastProjectByTarget?: Record<string, string>;
          };
        };
        const savedDevRoot = prefs.worktrees?.devRootByTarget?.[newTarget] ?? DEFAULT_DEV_ROOT;
        const savedProject = prefs.worktrees?.lastProjectByTarget?.[newTarget] ?? "";
        setDevRoot(savedDevRoot);
        setDevRootDraft(savedDevRoot);
        if (savedProject) setRepoPath(savedProject);
      } catch {
        // ignore
      }
    })();
  }

  function handleProjectChange(p: string) {
    setRepoPath(p);
    setWorktrees([]);
    setError(null);
    savePrefs(target, p, devRoot);
  }

  // ── Fetch worktrees when repoPath or target changes ───────────────────────
  const refresh = useCallback(async () => {
    if (!repoPath) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ target, repoPath });
      const res = await fetch(`/api/workbench/worktrees?${params.toString()}`);
      const data = (await res.json()) as { worktrees?: Worktree[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        setWorktrees(data.worktrees ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [repoPath, target]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!prPopover) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPrPopover(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [prPopover]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!branch.trim() || !repoPath) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/workbench/worktrees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, repoPath, branch: branch.trim(), baseBranch: baseBranch.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        setBranch("");
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(worktreePath: string) {
    setDeleting(worktreePath);
    setError(null);
    try {
      const res = await fetch("/api/workbench/worktrees", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, repoPath, worktreePath }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  }

  async function handleCreatePr(wt: Worktree) {
    setCreatingPr(wt.worktreePath);
    setError(null);
    try {
      const res = await fetch("/api/workbench/worktrees/prs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, worktreePath: wt.worktreePath, branch: wt.branch }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "PR creation failed");
      } else {
        window.open(data.url, "_blank", "noopener");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingPr(null);
    }
  }

  async function handleOpenPrPopover(wt: Worktree) {
    if (prPopover === wt.worktreePath) {
      setPrPopover(null);
      return;
    }
    setPrPopover(wt.worktreePath);
    setPrList([]);
    setPrLoading(true);
    try {
      const params = new URLSearchParams({ target, worktreePath: wt.worktreePath, branch: wt.branch });
      const res = await fetch(`/api/workbench/worktrees/prs?${params.toString()}`);
      const data = (await res.json()) as { prs?: PrEntry[]; error?: string };
      if (res.ok) setPrList(data.prs ?? []);
      else setError(data.error ?? "Could not fetch PRs");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPrLoading(false);
    }
  }

  function commitDevRoot() {
    const next = devRootDraft.trim() || DEFAULT_DEV_ROOT;
    setDevRoot(next);
    setEditingDevRoot(false);
    savePrefs(target, repoPath, next);
  }

  // ── Derive display name for a project path ────────────────────────────────
  function projectLabel(p: string): string {
    return p.split("/").pop() ?? p;
  }

  const projectName = repoPath ? projectLabel(repoPath) : "";

  return (
    <div style={{ padding: 20, maxWidth: 720 }}>

      {/* Machine + project selectors */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 16, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12 }}>
          <div style={{ marginBottom: 4, color: "var(--mute)" }}>Machine</div>
          <select
            value={target}
            onChange={(e) => handleTargetChange(e.target.value)}
            style={selectStyle}
          >
            <option value="local">local</option>
            {outposts.length > 0 && (
              <optgroup label="Outposts">
                {outposts.map((o) => (
                  <option key={o.name} value={`outpost:${o.name}`} disabled={!o.connected}>
                    {o.name}{!o.connected ? " (offline)" : ""}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <label style={{ fontSize: 12 }}>
          <div style={{ marginBottom: 4, color: "var(--mute)" }}>Project</div>
          <select
            value={repoPath}
            onChange={(e) => handleProjectChange(e.target.value)}
            disabled={projectsLoading || projects.length === 0}
            style={{ ...selectStyle, minWidth: 180 }}
          >
            {repoPath && !projects.includes(repoPath) && (
              <option value={repoPath}>{projectLabel(repoPath)}</option>
            )}
            {projects.map((p) => (
              <option key={p} value={p}>{projectLabel(p)}</option>
            ))}
            {projects.length === 0 && !projectsLoading && (
              <option value="" disabled>No projects found</option>
            )}
          </select>
        </label>

        {/* Dev root edit inline */}
        {editingDevRoot ? (
          <label style={{ fontSize: 12 }}>
            <div style={{ marginBottom: 4, color: "var(--mute)" }}>Dev folder</div>
            <div style={{ display: "flex", gap: 4 }}>
              <input
                type="text"
                value={devRootDraft}
                onChange={(e) => setDevRootDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitDevRoot();
                  if (e.key === "Escape") { setEditingDevRoot(false); setDevRootDraft(devRoot); }
                }}
                style={{ ...inputStyle, width: 160 }}
                autoFocus
              />
              <button type="button" className="btn small" onClick={commitDevRoot}>OK</button>
            </div>
          </label>
        ) : (
          <button
            type="button"
            className="btn small ghost"
            style={{ marginBottom: 1, fontSize: 11 }}
            onClick={() => { setEditingDevRoot(true); setDevRootDraft(devRoot); }}
            title={`Dev folder: ${devRoot}`}
          >
            {devRoot}
          </button>
        )}

        <span style={{ flex: 1 }} />

        <button
          type="button"
          className="btn small ghost"
          onClick={() => { void refresh(); }}
          disabled={loading || !repoPath}
          style={{ marginBottom: 1 }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Breadcrumb showing current repo */}
      {repoPath ? (
        <div style={{ fontSize: 11, color: "var(--mute)", marginBottom: 12 }}>
          <span style={{ fontFamily: "var(--font-mono)" }}>{repoPath}</span>
        </div>
      ) : null}

      {error ? (
        <div style={errorStyle}>{error}</div>
      ) : null}

      {worktrees.length > 0 ? (
        <table className="simple" style={{ marginBottom: 24 }}>
          <thead>
            <tr>
              <th>Branch</th>
              <th>Path</th>
              <th>Commit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {worktrees.map((wt) => (
              <tr key={wt.worktreePath}>
                <td>
                  <code style={{ fontSize: 12 }}>{wt.branch}</code>
                  {wt.isMain ? (
                    <span style={{ marginLeft: 6, fontSize: 10, color: "var(--mute)", textTransform: "uppercase" }}>
                      main
                    </span>
                  ) : null}
                </td>
                <td className="mono" style={{ fontSize: 11 }}>{wt.worktreePath}</td>
                <td className="mono">{wt.commit}</td>
                <td>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={!terminalInstalled}
                      title={
                        terminalInstalled
                          ? `Open Claude Code at ${wt.worktreePath}${target !== "local" ? ` on ${target.replace("outpost:", "")}` : ""}`
                          : "Add a terminal Fitting to your composition first"
                      }
                      onClick={() => dispatchLaunchClaude(wt.worktreePath, target)}
                    >
                      Claude Code
                    </button>
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={!terminalInstalled}
                      title={
                        terminalInstalled
                          ? `Continue last Claude Code session at ${wt.worktreePath}${target !== "local" ? ` on ${target.replace("outpost:", "")}` : ""}`
                          : "Add a terminal Fitting to your composition first"
                      }
                      onClick={() => dispatchLaunchClaude(wt.worktreePath, target, true)}
                    >
                      Continue
                    </button>
                    {!wt.isMain ? (
                      <button
                        type="button"
                        className="btn small ghost"
                        disabled={creatingPr === wt.worktreePath}
                        title="Create a pull request for this branch"
                        onClick={() => { void handleCreatePr(wt); }}
                      >
                        {creatingPr === wt.worktreePath ? "Creating PR…" : "Create PR"}
                      </button>
                    ) : null}
                    {!wt.isMain ? (
                      <div style={{ position: "relative" }}>
                        <button
                          type="button"
                          className="btn small ghost"
                          title="View pull requests for this branch"
                          onClick={() => { void handleOpenPrPopover(wt); }}
                        >
                          PRs
                        </button>
                        {prPopover === wt.worktreePath && (
                          <div
                            ref={popoverRef}
                            style={{
                              position: "absolute",
                              right: 0,
                              top: "calc(100% + 4px)",
                              zIndex: 50,
                              background: "white",
                              border: "1px solid var(--rule)",
                              minWidth: 280,
                              maxWidth: 400,
                              boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                              fontSize: 12,
                            }}
                          >
                            {prLoading ? (
                              <div style={{ padding: "10px 14px", color: "var(--mute)" }}>Loading…</div>
                            ) : prList.length === 0 ? (
                              <div style={{ padding: "10px 14px", color: "var(--mute)" }}>
                                No PRs for this branch yet.
                              </div>
                            ) : (
                              prList.map((pr) => (
                                <a
                                  key={pr.number}
                                  href={pr.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    padding: "8px 14px",
                                    borderBottom: "1px solid var(--rule)",
                                    textDecoration: "none",
                                    color: "var(--ink)",
                                  }}
                                  onClick={() => setPrPopover(null)}
                                >
                                  <span style={{ color: "var(--mute)", flexShrink: 0 }}>#{pr.number}</span>
                                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {pr.title}
                                  </span>
                                  <span
                                    className="pill"
                                    style={{
                                      fontSize: 10,
                                      flexShrink: 0,
                                      color: pr.state === "OPEN" ? "var(--sage)" : pr.state === "MERGED" ? "#6f42c1" : "var(--mute)",
                                    }}
                                  >
                                    {pr.state.toLowerCase()}
                                  </span>
                                </a>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    ) : null}
                    {!wt.isMain ? (
                      <button
                        type="button"
                        className="btn small danger"
                        onClick={() => { void handleDelete(wt.worktreePath); }}
                        disabled={deleting === wt.worktreePath}
                      >
                        {deleting === wt.worktreePath ? "Removing…" : "Remove"}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : !loading && repoPath ? (
        <p style={{ fontSize: 13, color: "var(--mute)", marginBottom: 24 }}>
          No worktrees found. Create one below.
        </p>
      ) : null}

      {repoPath ? (
        <form
          onSubmit={(e) => { void handleCreate(e); }}
          style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}
        >
          <label style={{ fontSize: 12 }}>
            <div style={{ marginBottom: 4, color: "var(--mute)" }}>New branch</div>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="feature/my-branch"
              style={{ ...inputStyle, width: 220 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            <div style={{ marginBottom: 4, color: "var(--mute)" }}>From</div>
            <input
              type="text"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder="main"
              style={{ ...inputStyle, width: 120 }}
            />
          </label>
          <button
            type="submit"
            className="btn primary small"
            disabled={creating || !branch.trim()}
            style={{ marginBottom: 1 }}
          >
            {creating ? "Creating…" : `Create on ${target === "local" ? "local" : projectName}`}
          </button>
        </form>
      ) : !projectsLoading ? (
        <p style={{ fontSize: 13, color: "var(--mute)" }}>
          No project selected. Pick a project above or adjust the dev folder path.
        </p>
      ) : null}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  padding: "5px 8px",
  border: "1px solid var(--rule)",
  borderRadius: 4,
  background: "var(--paper)",
  color: "var(--ink)",
};

const inputStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  padding: "6px 10px",
  border: "1px solid var(--rule)",
  borderRadius: 4,
  background: "var(--paper)",
  color: "var(--ink)",
};

const errorStyle: React.CSSProperties = {
  padding: "10px 14px",
  background: "var(--alarm-soft)",
  color: "var(--alarm)",
  fontSize: 12,
  borderRadius: 4,
  marginBottom: 16,
  whiteSpace: "pre-wrap",
};
