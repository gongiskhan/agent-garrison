"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConnectorView } from "@/lib/connectors-view";
import type { VaultAuditEntry } from "@/lib/vault-audit";
import styles from "./ConnectorsPanel.module.css";

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
  return "var(--alarm)";
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  padding: "10px 11px",
  border: "1px solid var(--rule)",
  borderRadius: 0,
  marginTop: 5,
  background: "var(--surface-strong)",
  color: "var(--ink)"
};

export function ConnectorsPanel() {
  const [data, setData] = useState<ConnectorsResponse | null>(null);
  const [audit, setAudit] = useState<VaultAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openConnect, setOpenConnect] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [oauthMode, setOauthMode] = useState<"choose" | "creds" | "manual">("choose");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

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
    // Surface the OAuth redirect result (?connected / ?connect_error).
    const q = new URLSearchParams(window.location.search);
    if (q.get("connected")) setNotice({ kind: "ok", text: `Connected ${q.get("connected")}.` });
    else if (q.get("connect_error")) setNotice({ kind: "err", text: `Connect failed: ${q.get("connect_error")}` });
    if (q.get("connected") || q.get("connect_error")) window.history.replaceState({}, "", window.location.pathname);
  }, [load]);

  const startConnect = (c: ConnectorView) => {
    setOpenConnect(c.id);
    setForm({});
    setOauthMode("choose");
    setNotice(null);
  };

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

  // api_key (and OAuth client-cred) submit -> /connect (scoped secret write).
  const submitSecrets = useCallback(
    async (id: string, keys: string[]) => {
      setBusy(id);
      try {
        const secrets: Record<string, string> = {};
        for (const k of keys) if (form[k]?.trim()) secrets[k] = form[k];
        const res = await fetch(`/api/connectors/${encodeURIComponent(id)}/connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secrets })
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "connect failed");
        return true;
      } catch (err) {
        setNotice({ kind: "err", text: err instanceof Error ? err.message : String(err) });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [form]
  );

  const startOAuthRedirect = useCallback(async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/connectors/${encodeURIComponent(id)}/oauth-start`);
      const j = await res.json();
      if (res.status === 409) {
        // Client credentials not set — reveal the creds form.
        setOauthMode("creds");
        return;
      }
      if (!res.ok || !j.authUrl) throw new Error(j.error || "could not start OAuth");
      window.location.href = j.authUrl; // hand off to the provider
    } catch (err) {
      setNotice({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, []);

  const submitManualToken = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        const res = await fetch(`/api/connectors/${encodeURIComponent(id)}/connect-oauth`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken: form.accessToken, refreshToken: form.refreshToken, expiresAt: form.expiresAt })
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "connect failed");
        setOpenConnect(null);
        setNotice({ kind: "ok", text: `Connected ${id}.` });
        await load();
      } catch (err) {
        setNotice({ kind: "err", text: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(null);
      }
    },
    [form, load]
  );

  return (
    <main>
      <div className="crumbs">
        <b>Connectors</b> · Vault-sealed
      </div>
      <div className="page">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>External lines</span>
            <h1>Connectors</h1>
          </div>
          <p>
            Authenticated routes beyond localhost. The Vault releases only the
            credentials each connector declared, only when that route runs.
          </p>
        </header>

        {error && <div className="banner alarm">Could not load connectors: {error}</div>}
        {data?.vault?.locked && (
          <div className="banner alarm">
            The Vault is locked or unavailable — connector credential status can’t be read. Unlock it in the Vault.
          </div>
        )}
        {notice && (
          <div className="banner" style={{ borderColor: notice.kind === "ok" ? "var(--sage)" : "var(--alarm)", color: notice.kind === "ok" ? "var(--sage)" : "var(--alarm)" }}>
            {notice.text}
          </div>
        )}

        <div className={styles.connectorGrid}>
          {(data?.connectors ?? []).map((c) => (
            <section key={c.id} className={styles.connectorCard}>
              <div className={styles.cardTop}>
                <div>
                  <span className={styles.cardIndex}>{String((data?.connectors ?? []).indexOf(c) + 1).padStart(2, "0")}</span>
                  <h2>{c.name}</h2>
                </div>
                {c.statusKnown ? (
                  <span className={styles.seal} title={c.sealed ? "Credentials present and valid" : "Credentials missing or invalid"} style={{ color: sealColor(c.sealed), borderColor: sealColor(c.sealed) }}>
                    {c.sealed ? "Vault-sealed" : "Not sealed"}
                  </span>
                ) : (
                  <span className={styles.seal} title="Unlock the Vault to read credential status">
                    Status unknown
                  </span>
                )}
              </div>

              <p className={styles.summary}>{c.summary}</p>

              <div className={styles.facts}>
                <span>{AUTH_LABEL[c.auth]}</span>
                <span>{c.actionCount} action{c.actionCount === 1 ? "" : "s"}</span>
                {c.mutatingActionCount > 0 && (
                  <span className={styles.mutating} title="actions that write or modify external state">{c.mutatingActionCount} mutating</span>
                )}
                {c.hasTriggers && <span>triggers</span>}
              </div>

              {c.statusKnown && c.auth === "api_key" && c.secrets.length > 0 && (
                <div className={styles.scope}>
                  <div className={styles.scopeLabel}>Scoped secrets</div>
                  <div className={styles.scopeValues}>
                    {c.secrets.map((s) => (
                      <span key={s.name} title={s.present ? "present in vault" : "missing — click Connect"} style={{ borderColor: s.present ? "var(--sage)" : "var(--alarm)", color: s.present ? "var(--ink)" : "var(--alarm)" }}>
                        {s.present ? "● " : "○ "}{s.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {c.statusKnown && c.auth === "oauth2" && (
                <div className={styles.oauth} style={{ color: oauthColor(c.oauth?.status) }}>
                  OAuth: {c.oauth?.status ?? "not connected"}
                  {c.oauth?.expiresAt ? ` · expires ${new Date(c.oauth.expiresAt).toLocaleString()}` : ""}
                </div>
              )}

              {/* Connect / revoke actions */}
              {c.auth !== "none" && (
                <div className={styles.cardActions}>
                  <button className="btn small" onClick={() => startConnect(c)}>
                    {c.sealed ? "Reconnect" : "Connect"}
                  </button>
                  {c.auth === "oauth2" && c.oauth && c.oauth.status !== "revoked" && (
                    <button className="btn small ghost" disabled={busy === c.id} onClick={() => revoke(c.id)}>
                      {busy === c.id ? "…" : "Revoke"}
                    </button>
                  )}
                </div>
              )}

              {/* Inline connect form */}
              {openConnect === c.id && (
                <div className={styles.connectForm}>
                  {c.auth === "api_key" && (
                    <ConnectFields
                      labels={c.secrets.map((s) => s.name)}
                      form={form}
                      setForm={setForm}
                      busy={busy === c.id}
                      onSave={async () => {
                        if (await submitSecrets(c.id, c.secrets.map((s) => s.name))) {
                          setOpenConnect(null);
                          setNotice({ kind: "ok", text: `${c.name} secrets saved.` });
                          await load();
                        }
                      }}
                      onCancel={() => setOpenConnect(null)}
                    />
                  )}

                  {c.auth === "oauth2" && oauthMode === "choose" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <button className="btn small primary" disabled={busy === c.id} onClick={() => startOAuthRedirect(c.id)}>
                        {busy === c.id ? "…" : `Authorize with ${c.name}`}
                      </button>
                      <button className="btn small ghost" onClick={() => setOauthMode("manual")}>Paste a token instead</button>
                      <button className="btn small ghost" onClick={() => setOpenConnect(null)}>Cancel</button>
                    </div>
                  )}

                  {c.auth === "oauth2" && oauthMode === "creds" && (
                    <ConnectFields
                      title="Enter your OAuth app credentials (one-time). Register this redirect URI in your provider app, then Authorize."
                      labels={["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"]}
                      form={form}
                      setForm={setForm}
                      busy={busy === c.id}
                      saveLabel="Save & authorize"
                      onSave={async () => {
                        if (await submitSecrets(c.id, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"])) {
                          await startOAuthRedirect(c.id);
                        }
                      }}
                      onCancel={() => setOpenConnect(null)}
                    />
                  )}

                  {c.auth === "oauth2" && oauthMode === "manual" && (
                    <ConnectFields
                      title="Paste an access token (and optionally a refresh token + expiry ISO time)."
                      labels={["accessToken", "refreshToken", "expiresAt"]}
                      optional={["refreshToken", "expiresAt"]}
                      form={form}
                      setForm={setForm}
                      busy={busy === c.id}
                      onSave={() => submitManualToken(c.id)}
                      onCancel={() => setOpenConnect(null)}
                    />
                  )}
                </div>
              )}
            </section>
          ))}
          {data && data.connectors.length === 0 && (
            <div className={styles.empty}>
              <span aria-hidden>⌁</span>
              <strong>No connectors stationed</strong>
              <p>Add connector Fittings to the active composition to open an external line.</p>
            </div>
          )}
        </div>

        <div className={styles.logHead}>
          <div>
            <span className={styles.eyebrow}>Custody ledger</span>
            <h2>Vault access log</h2>
          </div>
          <p>Secret delivery, refresh, revoke, and denial—recorded by name, never by value.</p>
        </div>
        <section className={styles.audit}>
          {audit.length === 0 && <div className={styles.auditEmpty}>No access recorded yet.</div>}
          {audit.map((e, i) => (
            <div key={i} className={styles.auditRow}>
              <span>{new Date(e.ts).toLocaleString()}</span>
              <strong>{e.connector}</strong>
              <span>
                {e.action}
                {e.secrets?.length ? ` [${e.secrets.join(", ")}]` : ""}
                {e.detail ? ` — ${e.detail}` : ""}
              </span>
              <b style={{ color: e.outcome === "ok" ? "var(--sage)" : "var(--alarm)" }}>{e.outcome}</b>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}

function ConnectFields(props: {
  labels: string[];
  form: Record<string, string>;
  setForm: (f: Record<string, string>) => void;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
  title?: string;
  optional?: string[];
  saveLabel?: string;
}) {
  const { labels, form, setForm, onSave, onCancel, busy, title, optional = [], saveLabel = "Save" } = props;
  return (
    <div>
      {title && <div style={{ fontSize: 12, color: "var(--mute)", marginBottom: 8 }}>{title}</div>}
      {labels.map((name) => (
        <label key={name} style={{ display: "block", marginBottom: 8 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {name}
            {optional.includes(name) ? " (optional)" : ""}
          </span>
          <input
            type="password"
            autoComplete="off"
            style={inputStyle}
            value={form[name] ?? ""}
            onChange={(e) => setForm({ ...form, [name]: e.target.value })}
          />
        </label>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button className="btn small primary" disabled={busy} onClick={() => void onSave()}>
          {busy ? "…" : saveLabel}
        </button>
        <button className="btn small ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
