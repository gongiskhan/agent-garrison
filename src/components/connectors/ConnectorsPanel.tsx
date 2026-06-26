"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConnectorView } from "@/lib/connectors-view";
import type { VaultAuditEntry } from "@/lib/vault-audit";

interface ConnectorsResponse {
  connectors: ConnectorView[];
  vault: { unlocked: boolean; locked: boolean; keySource?: string };
}

const AUTH_LABEL: Record<ConnectorView["auth"], string> = {
  oauth2: "OAuth",
  api_key: "API key",
  none: "No auth"
};

function sealColor(sealed: boolean) {
  return sealed ? "var(--sage)" : "var(--brass)";
}

function oauthColor(status?: string) {
  if (status === "valid") return "var(--sage)";
  if (status === "expiring") return "var(--brass)";
  return "var(--alarm)"; // expired / revoked
}

export function ConnectorsPanel() {
  const [data, setData] = useState<ConnectorsResponse | null>(null);
  const [audit, setAudit] = useState<VaultAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([
        fetch("/api/connectors").then((r) => r.json()),
        fetch("/api/vault/audit?limit=40").then((r) => r.json())
      ]);
      if (c.error) throw new Error(c.error);
      setData(c);
      setAudit((a.entries ?? []).slice().reverse());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await fetch(`/api/connectors/${encodeURIComponent(id)}/revoke`, { method: "POST" });
        await load();
      } finally {
        setBusy(null);
      }
    },
    [load]
  );

  return (
    <main>
      <div className="crumbs">
        <b>Connectors</b> · Vault-sealed
      </div>
      <div className="page">
        <div className="head">
          <h1>Connectors</h1>
          <p className="ld">
            Every connector and its credential state. Secrets are <strong>Vault-sealed</strong> — held
            AES-256-GCM-encrypted under a keychain master key, materialised just-in-time and scoped to the
            single connector that declared them. Values never appear here or in any log.
          </p>
        </div>

        {error && <div className="banner alarm">Could not load connectors: {error}</div>}
        {data?.vault?.locked && (
          <div className="banner alarm">
            The Vault is locked or unavailable — connector credential status can’t be read. Unlock it in the Vault.
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
            gap: 18,
            marginTop: 8
          }}
        >
          {(data?.connectors ?? []).map((c) => (
            <section
              key={c.id}
              style={{ border: "1px solid var(--rule)", background: "#fff", borderRadius: 8, padding: "18px 20px" }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>{c.name}</h2>
                {c.statusKnown ? (
                  <span
                    title={c.sealed ? "Credentials present and valid" : "Credentials missing or invalid"}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: sealColor(c.sealed),
                      border: `1px solid ${sealColor(c.sealed)}`,
                      borderRadius: 99,
                      padding: "2px 9px",
                      whiteSpace: "nowrap"
                    }}
                  >
                    {c.sealed ? "Vault-sealed" : "Not sealed"}
                  </span>
                ) : (
                  <span
                    title="Unlock the Vault to read credential status"
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--mute)",
                      border: "1px solid var(--rule)",
                      borderRadius: 99,
                      padding: "2px 9px",
                      whiteSpace: "nowrap"
                    }}
                  >
                    Status unknown
                  </span>
                )}
              </div>

              <p style={{ color: "var(--mute)", fontSize: 13, margin: "8px 0 12px" }}>{c.summary}</p>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 11, marginBottom: 12 }}>
                <span style={{ border: "1px solid var(--rule)", borderRadius: 4, padding: "2px 7px" }}>
                  {AUTH_LABEL[c.auth]}
                </span>
                <span style={{ border: "1px solid var(--rule)", borderRadius: 4, padding: "2px 7px" }}>
                  {c.actionCount} action{c.actionCount === 1 ? "" : "s"}
                </span>
                {c.mutatingActionCount > 0 && (
                  <span
                    title="actions that write/modify external state"
                    style={{ border: "1px solid var(--brass)", color: "var(--brass)", borderRadius: 4, padding: "2px 7px" }}
                  >
                    {c.mutatingActionCount} mutating
                  </span>
                )}
                {c.hasTriggers && (
                  <span style={{ border: "1px solid var(--rule)", borderRadius: 4, padding: "2px 7px" }}>triggers</span>
                )}
              </div>

              {c.statusKnown && c.auth === "api_key" && c.secrets.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: "var(--mute)", marginBottom: 4 }}>Scoped secrets</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {c.secrets.map((s) => (
                      <span
                        key={s.name}
                        title={s.present ? "present in vault" : "missing — add it in the Vault"}
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          border: `1px solid ${s.present ? "var(--sage)" : "var(--alarm)"}`,
                          color: s.present ? "var(--ink)" : "var(--alarm)",
                          borderRadius: 4,
                          padding: "2px 7px"
                        }}
                      >
                        {s.present ? "● " : "○ "}
                        {s.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {c.statusKnown && c.auth === "oauth2" && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 12, color: oauthColor(c.oauth?.status) }}>
                    OAuth: {c.oauth?.status ?? "not connected"}
                    {c.oauth?.expiresAt ? ` · expires ${new Date(c.oauth.expiresAt).toLocaleString()}` : ""}
                  </span>
                  {c.oauth && c.oauth.status !== "revoked" && (
                    <button className="btn small ghost" disabled={busy === c.id} onClick={() => revoke(c.id)}>
                      {busy === c.id ? "…" : "Revoke"}
                    </button>
                  )}
                </div>
              )}
            </section>
          ))}
          {data && data.connectors.length === 0 && (
            <div style={{ color: "var(--mute)" }}>No connectors installed yet.</div>
          )}
        </div>

        <div className="head" style={{ marginTop: 36 }}>
          <h1 style={{ fontSize: 20 }}>Vault access log</h1>
          <p className="ld">Every secret delivery, read, refresh, revoke, and denial — by name, never value.</p>
        </div>
        <section style={{ border: "1px solid var(--rule)", background: "#fff", borderRadius: 8, overflow: "hidden" }}>
          {audit.length === 0 && <div style={{ padding: 16, color: "var(--mute)" }}>No access recorded yet.</div>}
          {audit.map((e, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "150px 90px 1fr 80px",
                gap: 10,
                padding: "7px 14px",
                borderTop: i ? "1px solid var(--rule)" : "none",
                fontSize: 12,
                fontFamily: "var(--font-mono)"
              }}
            >
              <span style={{ color: "var(--mute)" }}>{new Date(e.ts).toLocaleString()}</span>
              <span>{e.connector}</span>
              <span style={{ color: "var(--mute)" }}>
                {e.action}
                {e.secrets?.length ? ` [${e.secrets.join(", ")}]` : ""}
                {e.detail ? ` — ${e.detail}` : ""}
              </span>
              <span style={{ color: e.outcome === "ok" ? "var(--sage)" : "var(--alarm)", textAlign: "right" }}>
                {e.outcome}
              </span>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
