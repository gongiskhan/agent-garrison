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
  enabled: boolean;
  ceiling: number;
}

interface UsageWindow {
  pct: number;
  resetAt: string | null;
  status: string | null;
}

interface AccountUsage {
  fiveHour: UsageWindow;
  weekly: UsageWindow;
  status: string | null;
  probedAt: string;
  error?: string;
}

interface JudgedCandidate {
  name: string;
  enabled: boolean;
  ceiling: number;
  tokenReady: boolean;
  usage: AccountUsage | null;
  effectivePct: number | null;
  eligible: boolean;
  reason: string | null;
}

interface PaymasterPayload {
  accounts: AccountInfo[];
  decision: {
    pick: string | null;
    candidates: JudgedCandidate[];
    nearestResetAt: string | null;
  };
  settings: { freshnessTtlMinutes: number; probeIntervalMinutes: number };
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
          <option value="auto">auto - Paymaster picks by usage</option>
          {accounts.map((account) => (
            <option key={account.name} value={account.name}>
              {accountOptionLabel(account)}
            </option>
          ))}
          {value && value !== "auto" && !selected ? (
            <option value={value}>{value} · not in registry</option>
          ) : null}
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
      {value === "auto" ? (
        <div className="hint" data-testid="account-auto-hint">
          Each operative spawn runs on the least-utilized eligible account (enabled + under
          ceiling); when every account is over ceiling the spawn holds instead of burning the
          window. Delegate sessions ride the operative&apos;s account.
        </div>
      ) : null}
      <PaymasterPanel autoSelected={value === "auto"} onPolicyChange={refresh} />
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

// PAYMASTER D11: the panel - every account's enabled toggle, ceiling editor,
// 5h/weekly utilization bars with reset countdowns, token age, probe freshness,
// and which account auto would pick right now. Autosaves (no Save buttons):
// toggles PATCH immediately, ceilings debounce. Numbers only - token values
// never reach the browser.

function formatCountdown(resetAt: string | null, now: number): string {
  if (!resetAt) return "";
  const ms = Date.parse(resetAt) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "resets now";
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `resets in ${minutes}m`;
}

function formatAgo(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function UsageBar({
  label,
  window: win,
  ceiling,
  now
}: {
  label: string;
  window: UsageWindow | null;
  ceiling: number;
  now: number;
}) {
  const pct = win ? Math.min(100, Math.max(0, win.pct)) : null;
  const over = pct !== null && pct >= ceiling;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 120 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
        <span className="hint">{label}</span>
        <span style={over ? { color: "var(--alarm, #a33)", fontWeight: 600 } : undefined}>
          {pct === null ? "-" : `${pct}%`}
        </span>
      </div>
      <div
        style={{
          position: "relative",
          height: 6,
          background: "var(--rule, #e2ddd2)",
          borderRadius: 3,
          overflow: "hidden"
        }}
      >
        {pct !== null ? (
          <div
            style={{
              position: "absolute",
              inset: "0 auto 0 0",
              width: `${pct}%`,
              background: over ? "var(--alarm, #a33)" : "var(--ink, #6b5d3f)",
              borderRadius: 3
            }}
          />
        ) : null}
        {ceiling < 100 ? (
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${Math.min(100, Math.max(0, ceiling))}%`,
              width: 2,
              background: "var(--alarm, #a33)",
              opacity: 0.7
            }}
            title={`ceiling ${ceiling}%`}
          />
        ) : null}
      </div>
      <span className="hint" style={{ fontSize: 10.5 }}>
        {win ? formatCountdown(win.resetAt, now) : "no data"}
      </span>
    </div>
  );
}

function PaymasterPanel({
  autoSelected,
  onPolicyChange
}: {
  autoSelected: boolean;
  onPolicyChange?: () => void;
}) {
  const [data, setData] = useState<PaymasterPayload | null>(null);
  const [probing, setProbing] = useState(false);
  const [ceilingDrafts, setCeilingDrafts] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingCeilingRef = useRef<Record<string, number>>({});

  const load = useCallback(async (refresh = false) => {
    try {
      const response = await fetch(`/api/accounts/paymaster${refresh ? "?refresh=1" : ""}`);
      if (!response.ok) return;
      setData((await response.json()) as PaymasterPayload);
      setNow(Date.now());
    } catch {
      /* transient - the panel keeps its last numbers */
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 60_000);
    // Stable objects; entries are mutated in place.
    const timers = debounceRef.current;
    const pending = pendingCeilingRef.current;
    return () => {
      clearInterval(poll);
      for (const timer of Object.values(timers)) clearTimeout(timer);
      // No-Save-button autosave: an edit made moments before unmount must
      // still persist - flush pending ceiling saves (fetch survives unmount).
      for (const [name, pct] of Object.entries(pending)) {
        void fetch(`/api/accounts/${encodeURIComponent(name)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ceiling: pct })
        }).catch(() => undefined);
      }
    };
  }, [load]);

  const patchPolicy = useCallback(
    async (name: string, body: { enabled?: boolean; ceiling?: number }) => {
      try {
        await fetch(`/api/accounts/${encodeURIComponent(name)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        void load();
        onPolicyChange?.();
      } catch {
        /* transient */
      }
    },
    [load, onPolicyChange]
  );

  if (!data || data.accounts.length === 0) return null;

  const byName = new Map(data.decision.candidates.map((candidate) => [candidate.name, candidate]));

  return (
    <div
      data-testid="paymaster-panel"
      style={{
        border: "1px solid var(--rule)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        marginTop: 2
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12.5 }}>Paymaster</strong>
        <span className="hint" data-testid="paymaster-pick">
          {data.decision.pick
            ? `auto would pick: ${data.decision.pick}`
            : `auto would HOLD - every account over ceiling${
                data.decision.nearestResetAt
                  ? ` (nearest ${formatCountdown(data.decision.nearestResetAt, now) || "reset pending"})`
                  : ""
              }`}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn"
          data-testid="paymaster-probe-now"
          disabled={probing}
          onClick={() => {
            setProbing(true);
            void load(true).finally(() => setProbing(false));
          }}
        >
          {probing ? "Probing…" : "Probe now"}
        </button>
      </div>
      {data.accounts.map((account) => {
        const candidate = byName.get(account.name);
        const usage = candidate?.usage ?? null;
        const ceilingDraft = ceilingDrafts[account.name] ?? String(account.ceiling);
        return (
          <div
            key={account.name}
            data-testid={`paymaster-row-${account.name}`}
            style={{
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
              opacity: account.enabled ? 1 : 0.55
            }}
          >
            <div style={{ width: 150, display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="font-mono" style={{ fontSize: 12 }}>
                {account.name}
                {autoSelected && data.decision.pick === account.name ? " (pick)" : ""}
              </span>
              <span className="hint" style={{ fontSize: 10.5 }}>
                {account.label ? `${account.label} · ` : ""}
                {account.ageDays !== null ? `token ${account.ageDays}d old` : "token age unknown"}
              </span>
              <span className="hint" style={{ fontSize: 10.5 }}>
                {usage
                  ? `probed ${formatAgo(usage.probedAt, now)}${usage.error ? " · STALE (probe failing)" : ""}`
                  : "never probed"}
                {account.needs_relogin ? " · RE-LOGIN NEEDED" : ""}
              </span>
              {candidate && !candidate.eligible ? (
                <span style={{ fontSize: 10.5, color: "var(--alarm, #a33)" }}>{candidate.reason}</span>
              ) : null}
            </div>
            <label
              className="hint"
              style={{ display: "flex", alignItems: "center", gap: 4, paddingTop: 2 }}
            >
              <input
                type="checkbox"
                checked={account.enabled}
                data-testid={`paymaster-enabled-${account.name}`}
                onChange={(event) => void patchPolicy(account.name, { enabled: event.target.checked })}
              />
              enabled
            </label>
            <label className="hint" style={{ display: "flex", alignItems: "center", gap: 4, paddingTop: 2 }}>
              ceiling
              <input
                className="text"
                type="number"
                min={0}
                max={100}
                value={ceilingDraft}
                data-testid={`paymaster-ceiling-${account.name}`}
                style={{ width: 58 }}
                onChange={(event) => {
                  const next = event.target.value;
                  setCeilingDrafts((drafts) => ({ ...drafts, [account.name]: next }));
                  const prior = debounceRef.current[account.name];
                  if (prior) clearTimeout(prior);
                  const pct = Number(next);
                  // An emptied field must NOT autosave ceiling 0 (0 blocks the
                  // account entirely) - hold until a real number is typed.
                  if (next.trim() === "" || !Number.isFinite(pct)) {
                    delete pendingCeilingRef.current[account.name];
                    return;
                  }
                  pendingCeilingRef.current[account.name] = pct;
                  debounceRef.current[account.name] = setTimeout(() => {
                    delete pendingCeilingRef.current[account.name];
                    void patchPolicy(account.name, { ceiling: pct }).then(() => {
                      // Drop the draft so the input resyncs to the
                      // server-normalized value (clamped/rounded, CLI edits).
                      setCeilingDrafts((drafts) => {
                        const { [account.name]: _saved, ...rest } = drafts;
                        return rest;
                      });
                    });
                  }, 600);
                }}
              />
              %
            </label>
            <UsageBar label="5h" window={usage?.fiveHour ?? null} ceiling={account.ceiling} now={now} />
            <UsageBar label="weekly" window={usage?.weekly ?? null} ceiling={account.ceiling} now={now} />
          </div>
        );
      })}
      <span className="hint" style={{ fontSize: 10.5 }}>
        Live header probes under each account&apos;s own token - background every{" "}
        {data.settings.probeIntervalMinutes}m, re-probed at spawn when older than{" "}
        {data.settings.freshnessTtlMinutes}m. Limits are shared with claude.ai chat and Desktop for
        the same account.
      </span>
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
