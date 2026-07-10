import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// The Ports view is opened over localhost AND over Tailscale/LAN. For the
// "open in a new tab" action we build the URL against the tailnet host the
// server reports (reachable off-box), NOT window.location — that keeps the
// link valid when the viewer is a phone on the tailnet.
type PortRow = {
  port: number;
  address: string;
  loopback: boolean;
  wildcard: boolean;
  severity: "local" | "exposed" | "bound";
  pid: number | null;
  pids: number[];
  command: string | null;
  labelSource: "fitting" | "process" | "unknown";
  label: string | null;
  labelDetail: string | null;
};

type Snapshot = {
  ports: PortRow[];
  scannedAt: string | null;
  tailnetHost: string | null;
  platform: string;
  self: { port: number; pid: number };
};

const REFRESH_MS = 5000;

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = (body as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(err);
  }
  return body as T;
}

function labelSourceTag(source: PortRow["labelSource"]): string {
  switch (source) {
    case "fitting": return "fitting";
    case "process": return "process";
    default: return "unknown";
  }
}

function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Per-pid kill flow: "confirm" after first Kill click; "terminated" after a
  // SIGTERM was sent (unlocks the Force SIGKILL button for that pid).
  const [killState, setKillState] = useState<Record<number, "confirm" | "terminated">>({});
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (fresh = false) => {
    try {
      const data = await getJson<Snapshot>(`/api/ports${fresh ? "?fresh=1" : ""}`);
      setSnap(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
    const handle = setInterval(() => load(), REFRESH_MS);
    return () => clearInterval(handle);
  }, [load]);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    await load(true);
    setBusy(false);
  }, [load]);

  const openInBrowser = useCallback(async (port: number) => {
    try {
      await getJson(`/api/ports/${port}/open-in-browser`, { method: "POST" });
      flash(`Opened :${port} in the Browser pane`);
    } catch (err) {
      flash(`Browser pane: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [flash]);

  const copyUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      flash(`Copied ${url}`);
    } catch {
      flash(`Copy failed — ${url}`);
    }
  }, [flash]);

  const doKill = useCallback(async (pid: number, signal: "TERM" | "KILL") => {
    try {
      await getJson(`/api/pids/${pid}/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal })
      });
      flash(`Sent SIG${signal} to pid ${pid}`);
      setKillState((s) => ({ ...s, [pid]: signal === "TERM" ? "terminated" : "terminated" }));
      await load(true);
    } catch (err) {
      flash(`Kill pid ${pid}: ${err instanceof Error ? err.message : String(err)}`);
      setKillState((s) => {
        const next = { ...s };
        delete next[pid];
        return next;
      });
    }
  }, [flash, load]);

  const rows = snap?.ports ?? [];
  const host = snap?.tailnetHost ?? null;

  const summary = useMemo(() => {
    const exposed = rows.filter((r) => !r.loopback).length;
    return { total: rows.length, exposed, loopback: rows.length - exposed };
  }, [rows]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Ports</h1>
        <span className="muted count">
          {summary.total} listening · {summary.exposed} exposed · {summary.loopback} loopback
        </span>
        {snap?.scannedAt && (
          <span className="muted scanned">scanned {new Date(snap.scannedAt).toLocaleTimeString()}</span>
        )}
        <button className="btn refresh" onClick={refresh} disabled={busy}>
          {busy ? "Scanning…" : "Refresh"}
        </button>
      </header>

      {error && <div className="banner banner-error">Scan error: {error}</div>}
      {notice && <div className="banner banner-notice">{notice}</div>}

      <main className="content">
        {rows.length === 0 ? (
          <div className="empty-state">No listening TCP ports found.</div>
        ) : (
          <table className="ports-table">
            <thead>
              <tr>
                <th className="col-port">Port</th>
                <th className="col-bind">Bind</th>
                <th className="col-label">Label</th>
                <th className="col-pid">PID</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const openUrl = host ? `http://${host}:${row.port}` : null;
                const state = row.pid != null ? killState[row.pid] : undefined;
                return (
                  <tr key={`${row.address}:${row.port}`} className={row.loopback ? "row-local" : "row-exposed"}>
                    <td className="col-port" data-label="Port">
                      <span className="mono port-num">{row.port}</span>
                    </td>
                    <td className="col-bind" data-label="Bind">
                      <span className="mono bind-addr">{row.address}</span>
                      {row.loopback ? (
                        <span className="chip chip-loopback">loopback</span>
                      ) : row.wildcard ? (
                        <span className="chip chip-exposed">all interfaces</span>
                      ) : (
                        <span className="chip chip-bound">bound</span>
                      )}
                    </td>
                    <td className="col-label" data-label="Label">
                      <span className="label-text">{row.label ?? "(unknown)"}</span>
                      <span className={`chip chip-source chip-${row.labelSource}`}>{labelSourceTag(row.labelSource)}</span>
                      {row.labelDetail && <span className="muted label-detail">{row.labelDetail}</span>}
                    </td>
                    <td className="col-pid mono" data-label="PID">
                      {row.pid ?? "—"}
                    </td>
                    <td className="col-actions" data-label="Actions">
                      <div className="actions">
                        {openUrl && !row.loopback && (
                          <a className="btn btn-sm" href={openUrl} target="_blank" rel="noreferrer">Open</a>
                        )}
                        <button className="btn btn-sm" onClick={() => openInBrowser(row.port)}>Browser pane</button>
                        <button
                          className="btn btn-sm"
                          onClick={() => copyUrl(host ? `http://${host}:${row.port}` : `http://127.0.0.1:${row.port}`)}
                        >
                          Copy URL
                        </button>
                        {row.pid != null && row.pid > 1 && (
                          <KillControl
                            pid={row.pid}
                            state={state}
                            onArm={() => setKillState((s) => ({ ...s, [row.pid as number]: "confirm" }))}
                            onCancel={() => setKillState((s) => {
                              const next = { ...s };
                              delete next[row.pid as number];
                              return next;
                            })}
                            onTerm={() => doKill(row.pid as number, "TERM")}
                            onKill={() => doKill(row.pid as number, "KILL")}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}

function KillControl(props: {
  pid: number;
  state: "confirm" | "terminated" | undefined;
  onArm: () => void;
  onCancel: () => void;
  onTerm: () => void;
  onKill: () => void;
}) {
  const { state, onArm, onCancel, onTerm, onKill } = props;
  if (state === "terminated") {
    return (
      <span className="kill-flow">
        <button className="btn btn-sm btn-danger" onClick={onKill}>Force SIGKILL</button>
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>Done</button>
      </span>
    );
  }
  if (state === "confirm") {
    return (
      <span className="kill-flow">
        <button className="btn btn-sm btn-danger" onClick={onTerm}>Confirm SIGTERM</button>
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
      </span>
    );
  }
  return <button className="btn btn-sm btn-danger-outline" onClick={onArm}>Kill</button>;
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
