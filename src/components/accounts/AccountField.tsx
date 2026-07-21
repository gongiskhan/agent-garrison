"use client";

// AccountField — RUNTIME-ACCOUNTS-V1 Phase 2. The account selector + guided
// "Log in / add account" flow for Anthropic-backed runtime Fittings. Rendered
// wherever a config_schema field with key "account" appears (Compose
// FacultyStation and Muster StandingFittings both delegate here). The caller
// provides the field chrome (label/hint wrapper); this component renders the
// control cluster: select, status line, and the login dialog.
//
// Vault discipline: only names, ages and statuses ever reach this component —
// token values stay server-side, and the login dialog's output tail arrives
// pre-redacted.

import { useCallback, useEffect, useRef, useState } from "react";

interface AccountInfo {
  name: string;
  label?: string;
  created_at: string;
  needs_relogin?: boolean;
  status: "ready" | "missing-token" | "vault-locked";
  ageDays: number | null;
}

interface LoginStatus {
  id: string;
  accountName: string;
  state: string;
  authorizeUrl: string | null;
  outputTail: string;
  error: string | null;
  verify: { ok: boolean; detail: string } | null;
}

function accountOptionLabel(account: AccountInfo): string {
  const bits = [account.name];
  if (account.label) bits.push(account.label);
  if (account.ageDays !== null) bits.push(`${account.ageDays}d old`);
  if (account.needs_relogin) bits.push("RE-LOGIN NEEDED");
  else if (account.status !== "ready") bits.push(account.status);
  return bits.join(" · ");
}

export function AccountField({
  value,
  onChange
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogName, setDialogName] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/accounts");
      if (!response.ok) return;
      const body = (await response.json()) as { accounts: AccountInfo[] };
      setAccounts(body.accounts ?? []);
    } catch {
      /* transient — the selector keeps its last list */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = accounts.find((account) => account.name === value);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select
          className="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          data-testid="account-select"
          style={{ flex: 1 }}
        >
          <option value="">machine login (default)</option>
          {accounts.map((account) => (
            <option key={account.name} value={account.name}>
              {accountOptionLabel(account)}
            </option>
          ))}
          {value && !selected ? <option value={value}>{value} · not in registry</option> : null}
        </select>
        <button
          type="button"
          className="btn"
          data-testid="account-login-open"
          onClick={() => {
            setDialogName(value && selected ? "" : value);
            setDialogOpen(true);
          }}
        >
          Log in / add account
        </button>
        {selected ? (
          <button
            type="button"
            className="btn"
            data-testid="account-relogin"
            onClick={() => {
              setDialogName(selected.name);
              setDialogOpen(true);
            }}
          >
            Re-login
          </button>
        ) : null}
      </div>
      {selected ? (
        <div className="hint" data-testid="account-status">
          {selected.status === "ready"
            ? `token in vault${selected.ageDays !== null ? ` · ${selected.ageDays}d old (setup tokens last about a year)` : ""}`
            : selected.status === "vault-locked"
              ? "vault locked — unlock it to use this account"
              : "no token in the vault — log in again"}
          {selected.needs_relogin ? " · a session under this account hit an auth error; re-login." : ""}
        </div>
      ) : null}
      {dialogOpen ? (
        <LoginDialog
          initialName={dialogName}
          onClose={() => {
            setDialogOpen(false);
            void refresh();
          }}
          onAdded={(name) => {
            onChange(name);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

// D6 best-effort: a runtime's NATIVE login (x-garrison.login block) run in the
// same guided PTY surface — start, watch the output, type a line when the flow
// asks for one. No vault capture; credentials land where the runtime keeps them.
export function GenericLoginPanel({
  fittingId,
  storageHint
}: {
  fittingId: string;
  storageHint?: string;
}) {
  const [loginId, setLoginId] = useState<string | null>(null);
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const terminal =
    status?.state === "finished" || status?.state === "error" || status?.state === "cancelled";
  useEffect(() => {
    if (terminal && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [terminal]);

  const start = async () => {
    setError(null);
    try {
      const response = await fetch("/api/accounts/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fittingId })
      });
      const body = await response.json();
      if (!response.ok) {
        setError(String(body.error ?? "login start failed"));
        return;
      }
      setLoginId(body.id);
      pollRef.current = setInterval(async () => {
        try {
          const poll = await fetch(`/api/accounts/login/${body.id}`);
          if (poll.ok) setStatus((await poll.json()) as LoginStatus);
        } catch {
          /* transient */
        }
      }, 1000);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {!loginId ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" className="btn" onClick={() => void start()} data-testid={`generic-login-${fittingId}`}>
            Log in (native)
          </button>
          {storageHint ? <span className="hint">credentials land in {storageHint}</span> : null}
        </div>
      ) : (
        <>
          <div className="hint">native login · state: {status?.state ?? "starting"}</div>
          {status?.authorizeUrl ? (
            <a href={status.authorizeUrl} target="_blank" rel="noreferrer" className="font-mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
              {status.authorizeUrl}
            </a>
          ) : null}
          {status?.outputTail ? (
            <pre
              className="font-mono"
              style={{
                fontSize: 10.5,
                maxHeight: 140,
                overflowY: "auto",
                background: "white",
                border: "1px solid var(--rule)",
                padding: 8,
                whiteSpace: "pre-wrap"
              }}
            >
              {status.outputTail}
            </pre>
          ) : null}
          {!terminal ? (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="text"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="type a line into the login flow (code, choice, …)"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (!loginId || !input.trim()) return;
                  void fetch(`/api/accounts/login/${loginId}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "code", code: input.trim() })
                  });
                  setInput("");
                }}
              >
                Send
              </button>
            </div>
          ) : null}
          {status?.error ? <div style={{ color: "var(--alarm, #a33)" }}>{status.error}</div> : null}
        </>
      )}
      {error ? <div style={{ color: "var(--alarm, #a33)" }}>{error}</div> : null}
    </div>
  );
}

function LoginDialog({
  initialName,
  onClose,
  onAdded
}: {
  initialName: string;
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [label, setLabel] = useState("");
  const [loginId, setLoginId] = useState<string | null>(null);
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [code, setCode] = useState("");
  const [manual, setManual] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loginIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      // Abandoning the dialog cancels an in-flight PTY attempt.
      const id = loginIdRef.current;
      if (id) {
        void fetch(`/api/accounts/login/${id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "cancel" })
        }).catch(() => undefined);
      }
    };
  }, []);

  const terminal = status?.state === "done" || status?.state === "error" || status?.state === "cancelled";
  useEffect(() => {
    if (terminal && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      loginIdRef.current = null;
    }
    if (status?.state === "done") onAdded(status.accountName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, status?.state]);

  const start = async () => {
    setError(null);
    try {
      const response = await fetch("/api/accounts/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, label: label || undefined })
      });
      const body = await response.json();
      if (!response.ok) {
        setError(String(body.error ?? "login start failed"));
        return;
      }
      setLoginId(body.id);
      loginIdRef.current = body.id;
      pollRef.current = setInterval(async () => {
        try {
          const poll = await fetch(`/api/accounts/login/${body.id}`);
          if (poll.ok) setStatus((await poll.json()) as LoginStatus);
        } catch {
          /* transient */
        }
      }, 1000);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    }
  };

  const submitCode = async () => {
    if (!loginId || !code.trim()) return;
    await fetch(`/api/accounts/login/${loginId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "code", code: code.trim() })
    }).catch(() => undefined);
    setCode("");
  };

  const saveManual = async () => {
    setError(null);
    try {
      const response = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, token: manualToken, label: label || undefined })
      });
      const body = await response.json();
      if (!response.ok) {
        setError(String(body.error ?? "save failed"));
        return;
      }
      setManualToken("");
      onAdded(name);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20, 18, 12, 0.45)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }}
      data-testid="account-login-dialog"
    >
      <div
        style={{
          width: "min(680px, 92vw)",
          maxHeight: "86vh",
          overflowY: "auto",
          background: "var(--paper, #fdfbf7)",
          border: "1px solid var(--rule)",
          padding: "18px 22px",
          display: "flex",
          flexDirection: "column",
          gap: 12
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <strong>Add an Anthropic account</strong>
          <button type="button" className="btn" onClick={onClose} data-testid="account-login-close">
            Close
          </button>
        </div>

        {!loginId ? (
          <>
            <div className="field">
              <label>account name</label>
              <input
                className="text"
                value={name}
                placeholder="personal / work1 / work2"
                onChange={(event) => setName(event.target.value.toLowerCase())}
                data-testid="account-login-name"
              />
            </div>
            <div className="field">
              <label>label (optional)</label>
              <input className="text" value={label} onChange={(event) => setLabel(event.target.value)} />
            </div>
            {!manual ? (
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn" onClick={() => void start()} data-testid="account-login-start">
                  Start login (claude setup-token)
                </button>
                <button type="button" className="btn" onClick={() => setManual(true)} data-testid="account-manual-toggle">
                  Paste a token instead
                </button>
              </div>
            ) : (
              <>
                <div className="field">
                  <label>token (from `claude setup-token` anywhere)</label>
                  <input
                    className="text"
                    type="password"
                    value={manualToken}
                    onChange={(event) => setManualToken(event.target.value)}
                    placeholder="sk-ant-oat01-…"
                    data-testid="account-manual-token"
                  />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn" onClick={() => void saveManual()} data-testid="account-manual-save">
                    Seal into vault
                  </button>
                  <button type="button" className="btn" onClick={() => setManual(false)}>
                    Back
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="hint">
              Running <span className="font-mono">claude setup-token</span> for account{" "}
              <span className="font-mono">{name}</span> — state: {status?.state ?? "starting"}
            </div>
            {status?.authorizeUrl ? (
              <div style={{ border: "1px solid var(--rule)", padding: "10px 12px", background: "white" }}>
                <div style={{ marginBottom: 6 }}>
                  Open this URL in a browser that is logged into the account you want to add:
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <a
                    href={status.authorizeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono"
                    style={{ fontSize: 12, wordBreak: "break-all", flex: 1 }}
                    data-testid="account-authorize-url"
                  >
                    {status.authorizeUrl}
                  </a>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      void navigator.clipboard.writeText(status.authorizeUrl ?? "").then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      });
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="hint" style={{ marginTop: 8 }}>
                  After authorizing, the page shows a code — paste it here:
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <input
                    className="text"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="authorization code"
                    style={{ flex: 1 }}
                    data-testid="account-code-input"
                  />
                  <button type="button" className="btn" onClick={() => void submitCode()} data-testid="account-code-submit">
                    Submit code
                  </button>
                </div>
              </div>
            ) : null}
            {status?.state === "verifying" ? (
              <div className="hint">Token captured and sealed in the vault. Verifying with a live probe…</div>
            ) : null}
            {status?.state === "done" ? (
              <div data-testid="account-login-result">
                {status.verify?.ok
                  ? `Account "${status.accountName}" is ready — the live probe answered under the new token.`
                  : `Token stored, but verification failed: ${status.verify?.detail ?? "no probe result"}. The account is flagged for re-login.`}
              </div>
            ) : null}
            {status?.error ? <div style={{ color: "var(--alarm, #a33)" }}>{status.error}</div> : null}
            {status?.outputTail ? (
              <pre
                className="font-mono"
                style={{
                  fontSize: 10.5,
                  maxHeight: 160,
                  overflowY: "auto",
                  background: "white",
                  border: "1px solid var(--rule)",
                  padding: 8,
                  whiteSpace: "pre-wrap"
                }}
              >
                {status.outputTail}
              </pre>
            ) : null}
          </>
        )}
        {error ? <div style={{ color: "var(--alarm, #a33)" }}>{error}</div> : null}
      </div>
    </div>
  );
}
