"use client";

import { useToolDiscovery } from "./useToolDiscovery";

// Thin discovery list. Reads ~/.garrison/ui-fittings/*.json via a server-side
// route, then polls each Fitting's /health from the browser to surface a
// link.
//
// No Fitting UI is embedded here — each entry is a link that opens the
// Fitting's own React app on its own port.

export function ToolsPanel() {
  const { entries, loading, error, refresh } = useToolDiscovery();

  const sorted = [...entries].sort((a, b) => a.fittingId.localeCompare(b.fittingId));

  return (
    <div style={{ padding: 24, maxWidth: 900 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0, marginBottom: 4 }}>Tools</h1>
      <p style={{ color: "var(--mute)", fontSize: 13, margin: 0, marginBottom: 16 }}>
        Stand-alone tool Fittings discovered via <code>~/.garrison/ui-fittings/*.json</code>.
      </p>

      <div className="strip" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: "var(--mute)", fontSize: 12 }}>
          {loading ? "Loading…" : `${sorted.length} fitting${sorted.length === 1 ? "" : "s"} on disk`}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn small ghost" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ padding: "10px 14px", background: "var(--alarm-soft)", color: "var(--alarm)", fontSize: 12, borderRadius: 4, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {sorted.length === 0 ? (
        <p style={{ color: "var(--mute)", fontSize: 13 }}>
          No tool Fittings running. Start a composition that includes tool Fittings (terminal, screen-share, worktree-management, session-view, outposts, monitor) to populate this page.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {sorted.map((t) => (
            <li
              key={t.fittingId}
              style={{
                padding: 12,
                marginBottom: 8,
                background: "var(--bg-2)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                display: "flex",
                alignItems: "center",
                gap: 12,
                opacity: t.healthy === false ? 0.5 : 1
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background:
                    t.healthy === true
                      ? "var(--sage)"
                      : t.healthy === false
                      ? "var(--alarm)"
                      : "var(--mute)"
                }}
                aria-label={t.healthy === true ? "healthy" : t.healthy === false ? "unreachable" : "checking"}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{t.fittingId}</div>
                <div style={{ color: "var(--mute)", fontSize: 11 }}>
                  port {t.port}
                  {t.pid && ` · pid ${t.pid}`}
                  {t.startedAt && ` · since ${new Date(t.startedAt).toLocaleTimeString()}`}
                </div>
              </div>
              {t.healthy === true ? (
                <a
                  href={t.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn small primary"
                  style={{ textDecoration: "none" }}
                >
                  Open
                </a>
              ) : (
                <span style={{ color: "var(--mute)", fontSize: 11 }}>
                  {t.healthy === false ? "unreachable" : "checking…"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
