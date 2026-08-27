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
  tunnel: string | null;
  tmuxSession: string;
  cwd: string;
}

// Deliberately not `alive`. Process-table liveness is the word that reported
// "healthy" all the way through an outage where the tunnel client held no
// listener at all; `carrying` means the forward answered as ssh.
interface TunnelRow {
  carrying: boolean;
  state: string;
  lastOkAt: string | null;
  probeReason: string | null;
  misses: number;
  parked: { reason: string; message: string } | null;
  repairing: boolean;
  backoffUntil: string | null;
  child: { alive: boolean; startedAt: string; restarts: number } | null;
  lastError: string | null;
}

function agoLabel(iso: string | null): string {
  if (!iso) return "never";
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function tunnelHealth(row: TunnelRow | undefined): { tone: string; label: string; detail: string | null } {
  if (!row) return { tone: "unknown", label: "unknown", detail: null };
  if (row.carrying) return { tone: "up", label: "up", detail: `carried ${agoLabel(row.lastOkAt)}` };
  if (row.repairing) return { tone: "repairing", label: "repairing", detail: "replacing the tunnel client" };
  if (row.parked) return { tone: "parked", label: "parked", detail: row.parked.message };
  return {
    tone: "down",
    label: row.state === "unknown" ? "unknown" : row.state,
    // The whole point of the probe's verdicts: "wedged" and "refused" send the
    // reader to different machines.
    detail: row.probeReason ?? row.lastError ?? `last carried ${agoLabel(row.lastOkAt)}`
  };
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
  const [tunnels, setTunnels] = useState<Record<string, TunnelRow>>({});
  const [repairing, setRepairing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, t, h] = await Promise.all([
        api<{ sessions: SessionRow[] }>("/sessions"),
        api<{ transports: TransportRow[] }>("/transports"),
        api<{ tunnels: Record<string, TunnelRow> }>("/tunnels")
      ]);
      setSessions(s.sessions);
      setTransports(t.transports);
      setTunnels(h.tunnels ?? {});
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

  const repairTunnel = async (transport: string) => {
    setRepairing(transport);
    setError(null);
    try {
      await api(`/tunnels/${encodeURIComponent(transport)}/repair`, { method: "POST", body: "{}" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRepairing(null);
      void refresh();
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
        {transports.map((t) => {
          const row = t.tunnel ? tunnels[t.tunnel] : undefined;
          const health = t.tunnel ? tunnelHealth(row) : null;
          return (
            <div key={t.name} className="transport">
              <div className="transport-name">
                {t.label}
                <span className="transport-via">{t.via}</span>
              </div>
              {health && (
                <div className="link-row">
                  <span className={`dot link-${health.tone}`} aria-hidden />
                  <span className="link-label">{health.label}</span>
                  {row?.child && !row.carrying && (
                    // The sentence the old status shape made impossible to say.
                    <span className="link-note">child {row.child.alive ? "alive" : "gone"}</span>
                  )}
                </div>
              )}
              {health?.detail && <div className="link-detail">{health.detail}</div>}
              <button
                className="start"
                disabled={starting === t.name}
                onClick={() => startSession(t.name)}
              >
                {starting === t.name ? "Starting..." : "Start / attach"}
              </button>
              {t.tunnel && (
                <button
                  className="repair"
                  disabled={repairing === t.name || Boolean(row?.repairing)}
                  onClick={() => repairTunnel(t.name)}
                >
                  {repairing === t.name || row?.repairing ? "Repairing..." : "Repair tunnel"}
                </button>
              )}
            </div>
          );
        })}
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
