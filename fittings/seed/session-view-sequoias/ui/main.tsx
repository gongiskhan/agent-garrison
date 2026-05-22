import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type SessionStatus = "starting" | "working" | "waiting" | "idle" | "errored" | "dead" | "stale";

interface AggregatedSession {
  branch: string;
  worktreePath: string;
  lastStatus: SessionStatus;
  lastStatusAt: string;
  lastHookEvent?: string;
  projectName: string;
  projectPath: string;
  machine: string;
  online: boolean;
  id?: string;
  claudeSessionId?: string | null;
  title?: string;
  source?: string;
}

interface TerminalTab {
  id: string;
  name: string;
  cwd: string;
  shell: string;
  command?: string | null;
  busy: boolean;
  createdAt: string;
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
  dead: "alarm",
  stale: "mute"
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

function buildSpawnUrl(terminalUrl: string, cwd: string, command?: string, name?: string): string {
  const u = new URL(terminalUrl);
  if (cwd) u.searchParams.set("cwd", cwd);
  if (command) u.searchParams.set("command", command);
  if (name) u.searchParams.set("name", name);
  return u.toString();
}

function buildFocusUrl(terminalUrl: string, sessionId: string): string {
  const u = new URL(terminalUrl);
  u.searchParams.set("focus", sessionId);
  return u.toString();
}

function claudeCommand(claudeSessionId?: string | null): string {
  const flags = "--dangerously-skip-permissions";
  if (claudeSessionId) return `claude --resume ${claudeSessionId} ${flags}`;
  return `claude --continue ${flags}`;
}

async function findExistingClaudeTab(
  terminalUrl: string,
  cwd: string,
  name: string
): Promise<TerminalTab | null> {
  try {
    const u = new URL("/sessions", terminalUrl).toString();
    const res = await fetch(u);
    if (!res.ok) return null;
    const data = (await res.json()) as { sessions?: TerminalTab[] };
    const tabs = Array.isArray(data.sessions) ? data.sessions : [];
    return (
      tabs.find(
        (t) =>
          t.cwd === cwd &&
          t.name === name &&
          typeof t.command === "string" &&
          t.command.trim().startsWith("claude")
      ) ?? null
    );
  } catch {
    return null;
  }
}

const TERMINAL_WINDOW_NAME = "garrison-terminal";

function App() {
  const [sessions, setSessions] = useState<AggregatedSession[]>([]);
  const [outposts, setOutposts] = useState<OutpostSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminalUrl, setTerminalUrl] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    const fetchTerm = async () => {
      try {
        const t = await fetch("/terminal-target").then((res) => res.ok ? res.json() : null);
        if (!cancelled) setTerminalUrl(t && typeof t.url === "string" ? t.url : null);
      } catch { if (!cancelled) setTerminalUrl(null); }
    };
    void fetchTerm();
    const id = setInterval(fetchTerm, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  async function cleanup() {
    if (!confirm("Remove sessions whose worktree directory no longer exists from state.json?")) return;
    setCleaning(true);
    setCleanupResult(null);
    setError(null);
    try {
      const res = await fetch("/sessions/cleanup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `HTTP ${res.status}`);
      } else {
        const garrisonRemoved = data?.garrison?.removed?.length ?? 0;
        const sequoiasRemoved = data?.sequoias?.removed?.length ?? 0;
        setCleanupResult(`Removed ${garrisonRemoved + sequoiasRemoved} stale session entries.`);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(false);
    }
  }

  async function openTerminal(s: AggregatedSession) {
    if (!terminalUrl) {
      setError("Terminal fitting is not running.");
      return;
    }
    setError(null);
    // Open the named window synchronously inside the click handler. Browsers
    // gate window.open() on an active user gesture; without this, the later
    // call (after our `await findExistingClaudeTab`) would be classified as
    // programmatic and silently blocked, especially on Safari. On subsequent
    // clicks the named window is reused — no new browser tab spawns.
    const win = window.open("about:blank", TERMINAL_WINDOW_NAME);
    const navigate = (url: string) => {
      if (win) {
        try { win.location.href = url; return; } catch { /* fall through */ }
      }
      window.open(url, TERMINAL_WINDOW_NAME);
    };
    const existing = await findExistingClaudeTab(terminalUrl, s.worktreePath, s.branch);
    if (existing) {
      navigate(buildFocusUrl(terminalUrl, existing.id));
      return;
    }
    navigate(buildSpawnUrl(
      terminalUrl,
      s.worktreePath,
      claudeCommand(s.claudeSessionId),
      s.branch
    ));
  }

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
        <button type="button" className="btn small" onClick={() => void cleanup()} disabled={cleaning} title="Remove sessions whose worktree directory is gone">
          {cleaning ? "Cleaning…" : "Cleanup stale"}
        </button>
        <button type="button" className="btn small ghost" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </div>

      {cleanupResult && <div className="info-banner">{cleanupResult}</div>}
      {error && <div className="alert">{error}</div>}
      {!terminalUrl && (
        <div className="hint">Terminal fitting unreachable — per-row Terminal action will be disabled.</div>
      )}

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
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s, idx) => (
              <tr key={`${s.machine}:${s.projectPath}:${s.branch}:${idx}`} style={{ opacity: s.online ? 1 : 0.5 }}>
                <td style={{ color: "var(--mute)" }}>{s.machine}</td>
                <td>{s.projectName}</td>
                <td><code>{s.branch}</code></td>
                <td>
                  <span className="pill" title={s.lastHookEvent ? `last hook: ${s.lastHookEvent}` : undefined}>
                    <span className={`dot ${STATUS_DOT[s.lastStatus] ?? "mute"}`} />
                    {s.lastStatus}
                  </span>
                </td>
                <td style={{ color: "var(--mute)" }}>
                  {timeAgo(s.lastStatusAt)}
                </td>
                <td style={{ color: "var(--mute)", fontSize: 11 }}>
                  <code>{s.worktreePath || "—"}</code>
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!terminalUrl || !s.worktreePath}
                    title={s.claudeSessionId
                      ? "Resume this Claude session in the Garrison terminal"
                      : "Open the Garrison terminal at this worktree and run claude --continue"}
                    onClick={() => void openTerminal(s)}
                  >
                    Terminal
                  </button>
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
