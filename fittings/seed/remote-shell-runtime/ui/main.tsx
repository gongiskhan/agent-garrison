// remote-shell own-port UI — a session rail plus one live terminal pane.
//
// Each session is an attachment to a named tmux session on a remote transport
// (the CSG VM over the dev tunnel, a direct-ssh box, ...). The pane is the
// shared TerminalPane (dev-env's /io WS protocol); the rail shows hook-driven
// running/idle state pushed by the server over the same socket.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { TerminalPane } from "./terminal-pane";

interface SessionRow {
  id: string;
  transport: string;
  label: string;
  tmuxSession: string;
  state: "running" | "idle";
  createdAt: string;
  lastEventAt: string | null;
  attached: boolean;
  eventsWatcher: "up" | "down";
}

interface TransportRow {
  name: string;
  label: string;
  via: string;
  tmuxSession: string;
  cwd: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `${res.status} on ${path}`);
  return data as T;
}

function App() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [transports, setTransports] = useState<TransportRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([
        api<{ sessions: SessionRow[] }>("/sessions"),
        api<{ transports: TransportRow[] }>("/transports")
      ]);
      setSessions(s.sessions);
      setTransports(t.transports);
      setSelected((cur) => cur && s.sessions.some((x) => x.id === cur)
        ? cur
        : s.sessions[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Deep link: ?session=<id> selects, ?start=<transport> starts one.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const sessionId = q.get("session");
    if (sessionId) setSelected(sessionId);
    const start = q.get("start");
    if (start) void startSession(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startSession = async (transport: string) => {
    setStarting(transport);
    setError(null);
    try {
      const { session } = await api<{ session: SessionRow }>("/sessions", {
        method: "POST",
        body: JSON.stringify({ transport })
      });
      await refresh();
      setSelected(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(null);
    }
  };

  const current = useMemo(
    () => sessions.find((s) => s.id === selected) ?? null,
    [sessions, selected]
  );

  return (
    <div className="app">
      <aside className="rail">
        <h1>Remote Shell</h1>
        {error && <div className="error">{error}</div>}
        <div className="rail-section">Sessions</div>
        {sessions.length === 0 && <div className="empty">No sessions</div>}
        {sessions.map((s) => (
          <button
            key={s.id}
            className={`session ${s.id === selected ? "selected" : ""}`}
            onClick={() => setSelected(s.id)}
          >
            <span className={`dot ${s.state}`} aria-hidden />
            <span className="session-label">{s.label}</span>
            <span className="session-state">{s.state}</span>
          </button>
        ))}
        <div className="rail-section">Transports</div>
        {transports.map((t) => (
          <div key={t.name} className="transport">
            <div className="transport-name">
              {t.label}
              <span className="transport-via">{t.via}</span>
            </div>
            <button
              className="start"
              disabled={starting === t.name}
              onClick={() => startSession(t.name)}
            >
              {starting === t.name ? "Starting..." : "Start / attach"}
            </button>
          </div>
        ))}
      </aside>
      <main className="pane">
        {current ? (
          <TerminalPane key={current.id} ptyId={current.id} isActive />
        ) : (
          <div className="placeholder">Start a transport session to attach its terminal.</div>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
