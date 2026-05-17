import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

interface Outpost {
  name: string;
  connected: boolean;
  registeredAt?: string;
  lastSeenAt?: string;
  hostname?: string;
  tailscaleIp?: string;
}

function App() {
  const [outposts, setOutposts] = useState<Outpost[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/outposts");
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `HTTP ${res.status}`);
        setOutposts([]);
      } else {
        const list = Array.isArray(data) ? data : (data.outposts ?? data ?? []);
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
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  async function register() {
    if (!name.trim() || !token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/outposts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), token: token.trim() })
      });
      const data = await res.json();
      if (!res.ok) setError(data?.error ?? `HTTP ${res.status}`);
      else { setName(""); setToken(""); await refresh(); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function unregister(n: string) {
    if (!confirm(`Unregister outpost "${n}"?`)) return;
    try {
      await fetch(`/outposts/${encodeURIComponent(n)}`, { method: "DELETE" });
      await refresh();
    } catch {}
  }

  return (
    <div className="app">
      <div>
        <h1>Garrison Outposts</h1>
        <p className="subtitle">Tailscale-connected remote Macs. Proxies to outpost-host on 127.0.0.1:3702.</p>
      </div>

      <div className="strip">
        <span style={{ color: "var(--mute)", fontSize: 12 }}>
          {loading ? "Loading…" : `${outposts.length} outpost${outposts.length === 1 ? "" : "s"}`}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={() => void refresh()} disabled={loading}>Refresh</button>
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="form-row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="outpost name" />
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="token" />
        <button type="button" className="btn primary" disabled={busy || !name.trim() || !token.trim()} onClick={register}>
          {busy ? "Registering…" : "Register"}
        </button>
      </div>

      {outposts.length === 0 ? (
        <div className="empty">No outposts registered. Use the form above with the token printed by the outpost-bridge bootstrap.</div>
      ) : (
        <table className="simple">
          <thead>
            <tr><th>Name</th><th>Status</th><th>Tailscale IP</th><th>Last seen</th><th></th></tr>
          </thead>
          <tbody>
            {outposts.map((o) => (
              <tr key={o.name} style={{ opacity: o.connected ? 1 : 0.5 }}>
                <td><code>{o.name}</code></td>
                <td>
                  <span className="pill">
                    <span className={`dot ${o.connected ? "sage" : "alarm"}`} />
                    {o.connected ? "connected" : "offline"}
                  </span>
                </td>
                <td style={{ color: "var(--mute)" }}>{o.tailscaleIp ?? "—"}</td>
                <td style={{ color: "var(--mute)" }}>{o.lastSeenAt ?? "—"}</td>
                <td>
                  <button type="button" className="btn" onClick={() => void unregister(o.name)}>Unregister</button>
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
