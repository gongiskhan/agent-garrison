import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// ---------------------------------------------------------------------------
// Types (mirror the outpost-host GET /outposts entries + invocation log)
// ---------------------------------------------------------------------------

interface LogEntry {
  at: string;
  verb: string;
  outpost: string;
  caller: string;
  ok: boolean;
  ms: number;
  error?: string;
}

interface Outpost {
  name: string;
  connected: boolean;
  pending?: boolean;
  registeredAt?: string;
  lastHeartbeat?: string | null;
  agentVersion?: string | null;
  hostname?: string | null;
  tailscaleIp?: string | null;
  verbs?: string[];
}

const HEARTBEAT_FRESH_MS = 30_000;
const POLL_MS = 15_000;

function isOnline(o: Outpost): boolean {
  if (!o.connected || !o.lastHeartbeat) return false;
  const t = Date.parse(o.lastHeartbeat);
  return Number.isFinite(t) && Date.now() - t < HEARTBEAT_FRESH_MS;
}

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function tailnetHost(o: Outpost): string {
  return o.tailscaleIp || o.hostname || "";
}

// ---------------------------------------------------------------------------
// One outpost card — owns its ping / run / log ephemeral state
// ---------------------------------------------------------------------------

function OutpostCard({ o, onRemove }: { o: Outpost; onRemove: (name: string) => void }) {
  const online = isOnline(o);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [pinging, setPinging] = useState(false);
  const [pingErr, setPingErr] = useState<string | null>(null);

  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState(false);
  const [runOut, setRunOut] = useState<string | null>(null);

  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);

  const host = tailnetHost(o);

  async function ping() {
    setPinging(true);
    setPingErr(null);
    const t0 = performance.now();
    try {
      const res = await fetch(`/outposts/${encodeURIComponent(o.name)}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "exec.run", payload: { command: "true", timeout_ms: 5000 } })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        setPingErr(data?.error ?? `HTTP ${res.status}`);
        setPingMs(null);
      } else {
        setPingMs(Math.round(performance.now() - t0));
      }
    } catch (err) {
      setPingErr(err instanceof Error ? err.message : String(err));
      setPingMs(null);
    } finally {
      setPinging(false);
    }
  }

  async function run() {
    if (!cmd.trim()) return;
    setRunning(true);
    setRunOut(null);
    try {
      const res = await fetch(`/outposts/${encodeURIComponent(o.name)}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "exec.run", payload: { command: cmd.trim(), timeout_ms: 30000 } })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        setRunOut(`error: ${data?.error ?? `HTTP ${res.status}`}`);
      } else {
        const p = data?.result?.payload ?? {};
        const out = [p.stdout, p.stderr].filter(Boolean).join("\n") || p.output || "(no output)";
        const exit = typeof p.exit_code === "number" ? `\n[exit ${p.exit_code}]` : "";
        setRunOut(String(out) + exit);
        void loadLog(); // the run just landed in the invocation log
      }
    } catch (err) {
      setRunOut(`error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const res = await fetch(`/outposts/${encodeURIComponent(o.name)}/log?limit=20`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      setLog(Array.isArray(data?.entries) ? data.entries : []);
    } catch {
      setLog([]);
    } finally {
      setLogLoading(false);
    }
  }, [o.name]);

  function toggleLog() {
    const next = !logOpen;
    setLogOpen(next);
    if (next) void loadLog();
  }

  return (
    <div className={"card" + (online ? "" : " card-offline")}>
      <div className="card-head">
        <span className={"dot " + (online ? "sage" : o.pending ? "brass" : "alarm")} />
        <span className="card-name">{o.name}</span>
        <span className="state-label">{online ? "online" : o.pending ? "pending" : "offline"}</span>
        <span className="grow" />
        {host && <code className="host">{host}</code>}
      </div>

      <div className="meta-grid">
        <div><span className="k">Agent</span><span className="v">{o.agentVersion ?? "unknown"}</span></div>
        <div><span className="k">Last seen</span><span className="v">{fmtAgo(o.lastHeartbeat)}</span></div>
        <div>
          <span className="k">Latency</span>
          <span className="v">
            {pinging ? "pinging…" : pingMs != null ? `${pingMs} ms` : pingErr ? `error` : "—"}
          </span>
        </div>
        <div><span className="k">Registered</span><span className="v">{fmtAgo(o.registeredAt)}</span></div>
      </div>

      {o.pending && (
        <div className="note">Pending — waiting for this Mac's bridge to connect for the first time.</div>
      )}
      {pingErr && <div className="alert small">{pingErr}</div>}

      {o.verbs && o.verbs.length > 0 && (
        <div className="verbs">
          <span className="k">Verbs</span>
          {o.verbs.map((v) => (
            <code key={v} className="verb">{v}</code>
          ))}
        </div>
      )}

      <div className="run-row">
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
          placeholder="command to run (exec.run)"
          disabled={!online || running}
        />
        <button type="button" className="btn" disabled={!online || running || !cmd.trim()} onClick={() => void run()}>
          {running ? "Running…" : "Run"}
        </button>
      </div>
      {runOut != null && <pre className="run-out">{runOut}</pre>}

      <div className="actions">
        <button type="button" className="btn" disabled={!online || pinging} onClick={() => void ping()}>Ping now</button>
        <button type="button" className="btn" onClick={toggleLog}>{logOpen ? "Hide log" : "Show log"}</button>
        <span className="grow" />
        <button type="button" className="btn danger" onClick={() => onRemove(o.name)}>Remove</button>
      </div>

      {logOpen && (
        <div className="log">
          {logLoading ? (
            <div className="muted">Loading…</div>
          ) : log.length === 0 ? (
            <div className="muted">No invocations recorded yet.</div>
          ) : (
            <table className="log-table">
              <thead>
                <tr><th>When</th><th>Verb</th><th>Caller</th><th>ms</th><th>Result</th></tr>
              </thead>
              <tbody>
                {log.slice().reverse().map((e, i) => (
                  <tr key={i} className={e.ok ? "" : "log-fail"}>
                    <td className="mono">{fmtAgo(e.at)}</td>
                    <td className="mono">{e.verb}</td>
                    <td className="mono">{e.caller}</td>
                    <td className="mono">{e.ms}</td>
                    <td>{e.ok ? "ok" : (e.error || "error")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-outpost: pair-a-Mac + SSH provisioning
// ---------------------------------------------------------------------------

function AddOutpost({ onChanged }: { onChanged: () => void }) {
  const [tab, setTab] = useState<"pair" | "ssh">("pair");

  // Pair a new Mac
  const [pairName, setPairName] = useState("");
  const [pairBusy, setPairBusy] = useState(false);
  const [pairErr, setPairErr] = useState<string | null>(null);
  const [installer, setInstaller] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function pair() {
    if (!pairName.trim()) return;
    setPairBusy(true);
    setPairErr(null);
    setInstaller(null);
    setCopied(false);
    try {
      const res = await fetch("/registry/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: pairName.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.installer) {
        setPairErr(data?.error ?? `HTTP ${res.status}`);
      } else {
        setInstaller(data.installer);
        onChanged();
      }
    } catch (err) {
      setPairErr(err instanceof Error ? err.message : String(err));
    } finally {
      setPairBusy(false);
    }
  }

  async function copyInstaller() {
    if (!installer) return;
    try {
      await navigator.clipboard.writeText(installer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  // SSH provisioning
  const [sshHost, setSshHost] = useState("");
  const [sshUser, setSshUser] = useState("");
  const [provBusy, setProvBusy] = useState(false);
  const [provErr, setProvErr] = useState<string | null>(null);
  const [provLines, setProvLines] = useState<string[]>([]);
  const [provDone, setProvDone] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const outRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [provLines]);

  async function provision() {
    if (!sshHost.trim() || !sshUser.trim()) return;
    setProvBusy(true);
    setProvErr(null);
    setProvLines([]);
    setProvDone(null);
    esRef.current?.close();
    try {
      const res = await fetch("/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: sshHost.trim(), user: sshUser.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.jobId) {
        setProvErr(data?.error ?? `HTTP ${res.status}`);
        setProvBusy(false);
        return;
      }
      const es = new EventSource(`/provision/${encodeURIComponent(data.jobId)}/stream`);
      esRef.current = es;
      es.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data);
          if (typeof parsed.line === "string") setProvLines((prev) => prev.concat(parsed.line));
        } catch { /* ignore keepalive */ }
      };
      es.addEventListener("done", (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent).data);
          setProvDone(typeof parsed.exitCode === "number" ? parsed.exitCode : 0);
        } catch { setProvDone(0); }
        es.close();
        setProvBusy(false);
        onChanged();
      });
      es.onerror = () => { es.close(); setProvBusy(false); };
    } catch (err) {
      setProvErr(err instanceof Error ? err.message : String(err));
      setProvBusy(false);
    }
  }

  return (
    <div className="add">
      <div className="tabs">
        <button type="button" className={"tab" + (tab === "pair" ? " tab-active" : "")} onClick={() => setTab("pair")}>Pair a new Mac</button>
        <button type="button" className={"tab" + (tab === "ssh" ? " tab-active" : "")} onClick={() => setTab("ssh")}>SSH provisioning</button>
      </div>

      {tab === "pair" ? (
        <div className="tab-body">
          <p className="hint">Mint a token and get the one-line installer to run on the Mac.</p>
          <div className="form-row">
            <input value={pairName} onChange={(e) => setPairName(e.target.value)} placeholder="machine name (e.g. studio-mac)" />
            <button type="button" className="btn primary" disabled={pairBusy || !pairName.trim()} onClick={() => void pair()}>
              {pairBusy ? "Minting…" : "Generate installer"}
            </button>
          </div>
          {pairErr && <div className="alert small">{pairErr}</div>}
          {installer && (
            <div className="installer">
              <div className="installer-head">
                <span className="k">Run this on the Mac</span>
                <button type="button" className="btn" onClick={() => void copyInstaller()}>{copied ? "Copied" : "Copy"}</button>
              </div>
              <pre className="installer-cmd">{installer}</pre>
            </div>
          )}
        </div>
      ) : (
        <div className="tab-body">
          <p className="hint">Provision a reachable Mac over SSH (key auth; BatchMode). Output streams live below.</p>
          <div className="form-row">
            <input value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="tailnet host or IP" />
            <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="ssh user" />
            <button type="button" className="btn primary" disabled={provBusy || !sshHost.trim() || !sshUser.trim()} onClick={() => void provision()}>
              {provBusy ? "Provisioning…" : "Provision"}
            </button>
          </div>
          {provErr && <div className="alert small">{provErr}</div>}
          {(provLines.length > 0 || provDone != null) && (
            <pre className="prov-out" ref={outRef}>
              {provLines.join("\n")}
              {provDone != null ? `\n\n[done, exit ${provDone}]` : ""}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [outposts, setOutposts] = useState<Outpost[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/outposts", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `HTTP ${res.status}`);
        setOutposts([]);
      } else {
        const list = Array.isArray(data) ? data : (data.outposts ?? []);
        setOutposts(Array.isArray(list) ? list : []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const remove = useCallback(async (name: string) => {
    if (!window.confirm(`Remove outpost "${name}"? This unregisters it and drops the connection.`)) return;
    try {
      await fetch(`/outposts/${encodeURIComponent(name)}`, { method: "DELETE" });
      await refresh();
    } catch { /* refresh will surface state */ }
  }, [refresh]);

  const onlineCount = useMemo(() => outposts.filter(isOnline).length, [outposts]);

  return (
    <div className="app">
      <header>
        <h1>Garrison Outposts</h1>
        <p className="subtitle">Tailscale-connected remote Macs. Proxies to the outpost-host daemon on 127.0.0.1:23702.</p>
      </header>

      <div className="strip">
        <span className="muted">
          {loading ? "Loading…" : `${outposts.length} registered · ${onlineCount} online`}
        </span>
        <span className="grow" />
        <button type="button" className="btn" onClick={() => void refresh()} disabled={loading}>Refresh</button>
      </div>

      {error && <div className="alert">{error}</div>}

      <AddOutpost onChanged={refresh} />

      {outposts.length === 0 ? (
        <div className="empty">No outposts registered. Pair a Mac or provision one over SSH above.</div>
      ) : (
        <div className="cards">
          {outposts.map((o) => (
            <OutpostCard key={o.name} o={o} onRemove={remove} />
          ))}
        </div>
      )}
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
