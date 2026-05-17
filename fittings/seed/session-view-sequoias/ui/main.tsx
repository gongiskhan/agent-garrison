import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type SessionStatus = "starting" | "working" | "waiting" | "idle" | "errored" | "dead";

interface AggregatedSession {
  branch: string;
  worktreePath: string;
  lastStatus: SessionStatus;
  lastStatusAt: string;
  projectName: string;
  projectPath: string;
  machine: string;
  online: boolean;
  id?: string;
  title?: string;
}

interface OutpostSummary {
  name: string;
  online: boolean;
  lastSyncedAt: string | null;
}

const STATUS_DOT: Record<SessionStatus, string> = {
  working: "sage",
  waiting: "brass",
  starting: "brass",
  idle: "mute",
  errored: "alarm",
  dead: "alarm"
};

function timeAgo(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return new Date(t).toLocaleTimeString();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(t).toLocaleString();
}

function App() {
  const [sessions, setSessions] = useState<AggregatedSession[]>([]);
  const [outposts, setOutposts] = useState<OutpostSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failureRef = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/sessions");
      const data = (await res.json()) as { sessions?: AggregatedSession[]; outposts?: OutpostSummary[]; error?: string };
      if (!res.ok) {
        failureRef.current += 1;
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        failureRef.current = 0;
        setSessions(data.sessions ?? []);
        setOutposts(data.outposts ?? []);
      }
    } catch (err) {
      failureRef.current += 1;
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
      const delay = failureRef.current === 0 ? 3000 : Math.min(30000, 3000 * 2 ** Math.max(0, failureRef.current - 1));
      timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [refresh]);

  const empty = !loading && sessions.length === 0 && outposts.length === 0;

  return (
    <div className="app">
      <h1>Garrison Session View</h1>
      <p className="subtitle">Per-worktree Claude Code sessions. Reads ~/.garrison/sessions/state.json.</p>

      <div className="strip">
        <span className="count">
          {loading ? "Loading…" : `${sessions.length} session${sessions.length === 1 ? "" : "s"}`}
        </span>
        {outposts.length > 0 && (
          <span className="count">
            {outposts.map((o) => (
              <span key={o.name} style={{ marginLeft: 8 }}>
                <span className={`dot ${o.online ? "sage" : "alarm"}`} />
                {o.name}
              </span>
            ))}
          </span>
        )}
        <span className="sep" />
        <button type="button" className="btn small ghost" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && <div className="alert">{error}</div>}

      {empty && (
        <p className="empty">
          No active sessions. Sessions appear here when Claude Code hooks write to <code>~/.garrison/sessions/state.json</code>.
        </p>
      )}

      {sessions.length > 0 && (
        <table className="simple">
          <thead>
            <tr>
              <th>Machine</th>
              <th>Project</th>
              <th>Branch</th>
              <th>Status</th>
              <th>Since</th>
              <th>Worktree</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={`${s.machine}:${s.projectPath}:${s.branch}`} style={{ opacity: s.online ? 1 : 0.5 }}>
                <td style={{ color: "var(--mute)" }}>{s.machine}</td>
                <td>{s.projectName}</td>
                <td>
                  <code>{s.branch}</code>
                </td>
                <td>
                  <span className="pill">
                    <span className={`dot ${STATUS_DOT[s.lastStatus] ?? "mute"}`} />
                    {s.lastStatus}
                  </span>
                </td>
                <td style={{ color: "var(--mute)" }}>{timeAgo(s.lastStatusAt)}</td>
                <td style={{ color: "var(--mute)", fontSize: 11 }}>
                  <code>{s.worktreePath || "—"}</code>
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
