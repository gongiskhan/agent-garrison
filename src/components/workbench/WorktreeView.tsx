"use client";

import { useCallback, useEffect, useState } from "react";
import type { FittingViewProps } from "@/components/fitting-views/registry";

interface Worktree {
  worktreePath: string;
  branch: string;
  commit: string;
  isMain: boolean;
}

export default function WorktreeView({ config }: FittingViewProps) {
  const repoPath = (config.repo_path as string) ?? "";
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!repoPath) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workbench/worktrees?repoPath=${encodeURIComponent(repoPath)}`
      );
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
  }, [repoPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!branch.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/workbench/worktrees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoPath, branch: branch.trim(), baseBranch: baseBranch.trim() })
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
        body: JSON.stringify({ repoPath, worktreePath })
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

  if (!repoPath) {
    return (
      <div style={{ padding: 20, color: "var(--mute)", fontSize: 13 }}>
        Configure <code>repo_path</code> in the Compose tab to enable worktree management.
      </div>
    );
  }

  return (
    <div style={{ padding: 20, maxWidth: 720 }}>
      <div className="strip" style={{ marginBottom: 16 }}>
        <span style={{ fontSize: 12, color: "var(--mute)" }}>repo: {repoPath}</span>
        <span className="sep" />
        <button
          type="button"
          className="btn small ghost"
          onClick={() => { void refresh(); }}
          disabled={loading}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <div
          style={{
            padding: "10px 14px",
            background: "var(--alarm-soft)",
            color: "var(--alarm)",
            fontSize: 12,
            borderRadius: 4,
            marginBottom: 16,
            whiteSpace: "pre-wrap"
          }}
        >
          {error}
        </div>
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
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 10,
                        color: "var(--mute)",
                        textTransform: "uppercase"
                      }}
                    >
                      main
                    </span>
                  ) : null}
                </td>
                <td className="mono" style={{ fontSize: 11 }}>{wt.worktreePath}</td>
                <td className="mono">{wt.commit}</td>
                <td>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : !loading ? (
        <p style={{ fontSize: 13, color: "var(--mute)", marginBottom: 24 }}>
          No worktrees found. Create one below.
        </p>
      ) : null}

      <form onSubmit={(e) => { void handleCreate(e); }} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <label style={{ fontSize: 12 }}>
          <div style={{ marginBottom: 4, color: "var(--mute)" }}>New branch</div>
          <input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="feature/my-branch"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              padding: "6px 10px",
              border: "1px solid var(--rule)",
              borderRadius: 4,
              background: "var(--paper)",
              color: "var(--ink)",
              width: 220
            }}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          <div style={{ marginBottom: 4, color: "var(--mute)" }}>From</div>
          <input
            type="text"
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            placeholder="main"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              padding: "6px 10px",
              border: "1px solid var(--rule)",
              borderRadius: 4,
              background: "var(--paper)",
              color: "var(--ink)",
              width: 120
            }}
          />
        </label>
        <button
          type="submit"
          className="btn primary small"
          disabled={creating || !branch.trim()}
          style={{ marginBottom: 1 }}
        >
          {creating ? "Creating…" : "Create worktree"}
        </button>
      </form>
    </div>
  );
}
