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
          <p className="hint">Provision a reachable Mac over SSH (key auth; BatchMode): installs the bridge, then mirrors this host's Claude config to it and registers it for ongoing sync. Output streams live below.</p>
          <div className="form-row">
            <input value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="Tailscale IP or host" />
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
// Config sync — mirror this host's portable ~/.claude config onto the outposts
// ---------------------------------------------------------------------------

interface SyncTarget {
  name: string;
  sshUser: string;
  sshHost: string;
  addedAt?: string;
  lastSyncAt?: string;
  lastSyncOk?: boolean;
  lastError?: string;
}
interface SyncItemResult { name: string; ok: boolean; error?: string }
interface SyncTargetResult { name: string; ok: boolean; at?: string; error?: string; items?: SyncItemResult[] }

function ConfigSync() {
  const [targets, setTargets] = useState<Record<string, SyncTarget>>({});
  const [portable, setPortable] = useState<{ dirs: string[]; files: string[] }>({ dirs: [], files: [] });
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null); // target name, or "*" for all
  const [results, setResults] = useState<Record<string, SyncTargetResult>>({});

  const [addName, setAddName] = useState("");
  const [addHost, setAddHost] = useState("");
  const [addUser, setAddUser] = useState("");
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/sync/targets", { cache: "no-store" });
      const data = await res.json();
      setTargets(data?.targets ?? {});
      if (data?.portable) setPortable(data.portable);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function syncAll() {
    setSyncing("*");
    setErr(null);
    try {
      const res = await fetch("/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) setErr(data?.error ?? `HTTP ${res.status}`);
      const map: Record<string, SyncTargetResult> = {};
      for (const r of data?.results ?? []) map[r.name] = r;
      setResults(map);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(null);
    }
  }

  async function syncOne(name: string) {
    setSyncing(name);
    setErr(null);
    try {
      const res = await fetch(`/outposts/${encodeURIComponent(name)}/sync`, { method: "POST" });
      const data = await res.json();
      setResults((prev) => ({ ...prev, [name]: data }));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(null);
    }
  }

  async function addTarget() {
    if (!addHost.trim() || !addUser.trim()) return;
    setAdding(true);
    setErr(null);
    try {
      const res = await fetch("/sync/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: addName.trim() || addHost.trim(), sshUser: addUser.trim(), sshHost: addHost.trim() })
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data?.error ?? `HTTP ${res.status}`);
      } else {
        setAddName(""); setAddHost(""); setAddUser("");
        await refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  async function removeTarget(name: string) {
    if (!window.confirm(`Stop syncing Claude config to "${name}"?`)) return;
    try {
      await fetch(`/sync/targets/${encodeURIComponent(name)}`, { method: "DELETE" });
      await refresh();
    } catch { /* refresh surfaces state */ }
  }

  const list = Object.values(targets);
  const subset = [...portable.dirs, ...portable.files].join(", ") || "skills, commands, agents, rules, CLAUDE.md";

  return (
    <div className="add config-sync">
      <div className="cs-head">
        <h2>Claude config sync</h2>
        <button type="button" className="btn primary" disabled={syncing != null || list.length === 0} onClick={() => void syncAll()}>
          {syncing === "*" ? "Syncing…" : "Sync all now"}
        </button>
      </div>
      <p className="hint">
        This host's portable Claude config ({subset}) is mirrored to every configured outpost - on change, and here on demand.
        Machine-specific state (settings.json, plugins, sessions) is intentionally not synced.
      </p>
      {err && <div className="alert small">{err}</div>}

      {list.length === 0 ? (
        <div className="muted cs-empty">No sync targets yet. Provision a Mac over SSH (it auto-registers), or add one by Tailscale IP below.</div>
      ) : (
        <div className="cs-list">
          {list.map((t) => {
            const r = results[t.name];
            const ok = t.lastSyncOk;
            const state = t.lastSyncAt ? (ok ? "sage" : "alarm") : "brass";
            return (
              <div className="cs-row" key={t.name}>
                <span className={"dot " + state} />
                <span className="cs-name">{t.name}</span>
                <code className="host">{t.sshUser}@{t.sshHost}</code>
                <span className="grow" />
                <span className="cs-status">
                  {t.lastSyncAt ? `${ok ? "synced" : "failed"} ${fmtAgo(t.lastSyncAt)}` : "never synced"}
                </span>
                <button type="button" className="btn" disabled={syncing != null} onClick={() => void syncOne(t.name)}>
                  {syncing === t.name ? "Syncing…" : "Sync"}
                </button>
                <button type="button" className="btn danger" disabled={syncing != null} onClick={() => void removeTarget(t.name)}>Remove</button>
                {(t.lastError || (r && !r.ok)) && (
                  <div className="cs-err">{t.lastError || r?.error || (r?.items || []).filter((i) => !i.ok).map((i) => `${i.name}: ${i.error}`).join("; ")}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="cs-add">
        <p className="hint">Add a sync target by Tailscale IP (must be SSH-reachable with key auth from this host).</p>
        <div className="form-row">
          <input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="name (optional)" />
          <input value={addHost} onChange={(e) => setAddHost(e.target.value)} placeholder="Tailscale IP or host" />
          <input value={addUser} onChange={(e) => setAddUser(e.target.value)} placeholder="ssh user" />
          <button type="button" className="btn primary" disabled={adding || !addHost.trim() || !addUser.trim()} onClick={() => void addTarget()}>
            {adding ? "Adding…" : "Add target"}
          </button>
        </div>
      </div>
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

      <ConfigSync />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
