"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FittingViewProps } from "@/components/fitting-views/registry";

type SessionStatus = "starting" | "working" | "waiting" | "idle" | "errored" | "dead";

interface WorktreeSession {
  branch: string;
  worktreePath: string;
  lastStatus: SessionStatus;
  lastStatusAt: string;
  projectName: string;
  projectPath: string;
}

const STATUS_COLORS: Record<SessionStatus, string> = {
  working: "var(--sage)",
  waiting: "var(--brass-2)",
  starting: "var(--brass-2)",
  idle: "var(--mute)",
  errored: "var(--alarm)",
  dead: "var(--alarm)"
};

export default function SessionView(_props: FittingViewProps) {
  const [sessions, setSessions] = useState<WorktreeSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noState, setNoState] = useState(false);

  const failureCountRef = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/workbench/sessions");
      const data = (await res.json()) as {
        sessions?: WorktreeSession[];
        error?: string;
      };
      if (!res.ok) {
        failureCountRef.current += 1;
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        failureCountRef.current = 0;
        setSessions(data.sessions ?? []);
        setNoState((data.sessions ?? []).length === 0);
      }
    } catch (err) {
      failureCountRef.current += 1;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      await refresh();
      if (cancelled) return;
      // Back off on consecutive failures: 5s, 10s, 20s, 30s (cap).
      const delay = Math.min(30000, 5000 * 2 ** Math.max(0, failureCountRef.current - 1));
      timer = setTimeout(tick, delay);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [refresh]);

  async function openInTerminal(worktreePath: string) {
    try {
      await fetch("/api/trenches/terminals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: worktreePath })
      });
    } catch {
      // user can switch to Workbench > Terminal manually
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 720 }}>
      <div className="strip" style={{ marginBottom: 16 }}>
        <span style={{ fontSize: 12, color: "var(--mute)" }}>
          {loading ? "Loading…" : `${sessions.length} session${sessions.length !== 1 ? "s" : ""}`}
        </span>
        <span className="sep" />
        <button
          type="button"
          className="btn small ghost"
          onClick={() => { void refresh(); }}
          disabled={loading}
        >
          Refresh
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
            marginBottom: 16
          }}
        >
          {error}
        </div>
      ) : null}

      {noState && !loading ? (
        <p style={{ fontSize: 13, color: "var(--mute)" }}>
          No Sequoias sessions found. Sessions appear here when Sequoias is running and has
          active worktrees. State file: <code>~/.sequoias/state.json</code>
        </p>
      ) : null}

      {sessions.length > 0 ? (
        <table className="simple">
          <thead>
            <tr>
              <th>Project</th>
              <th>Branch</th>
              <th>Status</th>
              <th>Since</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={`${s.projectPath}:${s.worktreePath}:${s.branch}`}>
                <td style={{ fontSize: 12 }}>{s.projectName}</td>
                <td>
                  <code style={{ fontSize: 12 }}>{s.branch}</code>
                </td>
                <td>
                  <span
                    className="pill"
                    style={{
                      color: STATUS_COLORS[s.lastStatus] ?? "var(--mute)",
                      fontSize: 11
                    }}
                  >
                    {s.lastStatus}
                  </span>
                </td>
                <td style={{ fontSize: 11, color: "var(--mute)" }}>
                  {s.lastStatusAt ? new Date(s.lastStatusAt).toLocaleTimeString() : "—"}
                </td>
                <td>
                  {s.worktreePath ? (
                    <button
                      type="button"
                      className="btn small ghost"
                      title={`Open terminal in ${s.worktreePath}`}
                      onClick={() => { void openInTerminal(s.worktreePath); }}
                    >
                      Open terminal
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
