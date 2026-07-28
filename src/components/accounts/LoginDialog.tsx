"use client";

// LoginDialog + GenericLoginPanel — RUNTIME-ACCOUNTS-V1 the guided login surfaces.
// Extracted from AccountField so both the compact runtime picker and the
// dedicated Accounts surface (AccountsManager) reuse one implementation.
//
// Vault discipline: only names, ages and statuses ever reach these components —
// token values stay server-side, and the login dialog's output tail arrives
// pre-redacted.

import { useEffect, useRef, useState } from "react";
import {
  ACCOUNT_PLATFORMS,
  PLATFORM_SPECS,
  addMethodsFor,
  copyText,
  verifyChip,
  type AccountPlatform,
  type AddMethod,
  type LoginStatus,
  type LoginVerify
} from "./shared";
import { BusyLine, Spinner } from "./Spinner";
import { KeyGuide } from "./KeyGuide";

// The verdict panel shared by the guided and the paste flows. Tone comes from
// verifyChip, so "valid token, rate-limited account" reads as the warning it is
// rather than as a failed login.
function VerifyResult({
  verify,
  onDone
}: {
  verify: LoginVerify | null;
  onDone: () => void;
}) {
  const chip = verifyChip(verify);
  const tone = chip.tone === "mute" ? "info" : chip.tone;
  const glyph = chip.tone === "ok" ? "OK" : chip.tone === "alarm" ? "X" : "!";
  return (
    <div
      className={`banner ${tone}`}
      style={{ marginBottom: 0 }}
      data-testid="account-login-result"
      data-outcome={verify?.outcome ?? "none"}
    >
      <span className="glyph">{glyph}</span>
      <div style={{ flex: 1 }}>
        <h5>{chip.label}</h5>
        <p>{chip.detail}</p>
        <div className="actions">
          <button type="button" className="linklike" onClick={onDone} data-testid="account-login-done">
            Done
          </button>
        </div>
      </div>
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

export function LoginDialog({
  initialName,
  initialPlatform = "anthropic",
  initialMethod,
  onClose,
  onAdded
}: {
  initialName: string;
  initialPlatform?: AccountPlatform;
  /** Preselect a mechanism (e.g. the machine card's "Save as an account"). */
  initialMethod?: AddMethod;
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [label, setLabel] = useState("");
  const [platform, setPlatform] = useState<AccountPlatform>(initialPlatform);
  const [envKeysInput, setEnvKeysInput] = useState("");
  const [loginId, setLoginId] = useState<string | null>(null);
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [code, setCode] = useState("");
  // How this account's credential gets in. Defaults to the platform's best
  // available mechanism (guided/device where one exists, paste otherwise).
  const [method, setMethod] = useState<AddMethod>(
    initialMethod ?? addMethodsFor(initialPlatform)[0].id
  );
  const [manualToken, setManualToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  // Feedback state for the two waits the user would otherwise stare through:
  // starting the host PTY, and the seal+probe round trip on a pasted token.
  const [starting, setStarting] = useState(false);
  const [codeSubmitted, setCodeSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manualVerify, setManualVerify] = useState<LoginVerify | null>(null);
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
    setStarting(true);
    try {
      const response = await fetch("/api/accounts/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          label: label || undefined,
          platform,
          ...(method === "browser" ? { mode: "browser" } : {})
        })
      });
      const body = await response.json();
      if (!response.ok) {
        setError(String(body.error ?? "login start failed"));
        setStarting(false);
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
      setStarting(false);
    }
  };

  const submitCode = async () => {
    if (!loginId || !code.trim()) return;
    setCodeSubmitted(true);
    await fetch(`/api/accounts/login/${loginId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "code", code: code.trim() })
    }).catch(() => undefined);
    setCode("");
  };

  // Adopt the box's own CLI login as a named account - no browser, no code.
  const importNative = async () => {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const response = await fetch("/api/accounts/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, label: label || undefined, platform })
      });
      const body = await response.json();
      if (!response.ok) {
        setError(String(body.error ?? "import failed"));
        return;
      }
      onAdded(name);
      setManualVerify((body.verify as LoginVerify | undefined) ?? null);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setSaving(false);
    }
  };

  const saveManual = async () => {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const envKeys =
        platform === "custom" && method === "paste-token"
          ? envKeysInput.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean)
          : undefined;
      const response = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          token: manualToken,
          label: label || undefined,
          platform,
          credential_kind: method === "paste-auth" ? "auth-file" : "token",
          env_keys: envKeys,
          // Probe the provider before answering — a pasted token deserves the
          // same verdict as a guided one, and a typo is caught here.
          verify: true
        })
      });
      const body = await response.json();
      if (!response.ok) {
        setError(String(body.error ?? "save failed"));
        return;
      }
      setManualToken("");
      onAdded(name);
      // Hold the dialog open on the verdict instead of vanishing silently.
      setManualVerify((body.verify as LoginVerify | undefined) ?? null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const methods = addMethodsFor(platform);
  // The three mechanisms that produce a subscription credential (a config home)
  // rather than an env-var token.
  const isSubscriptionMethod =
    method === "browser" || method === "import" || method === "paste-auth";

  // What the guided flow is doing right now, and whether that is a wait.
  const phase = ((): { label: string; busy: boolean } => {
    const browser = method === "browser";
    const flow = PLATFORM_SPECS[platform].browserLogin?.flow;
    switch (status?.state) {
      case undefined:
      case "starting":
        return {
          label: `Starting \`${browser ? PLATFORM_SPECS[platform].browserLogin?.command : "claude setup-token"}\` on the host…`,
          busy: true
        };
      case "running":
        return { label: browser ? "Waiting for the authorization link…" : "Waiting for the authorization URL…", busy: true };
      case "awaiting-browser":
        // device-code has nothing to paste back, so it just waits; paste-code
        // hands the turn to the user exactly like setup-token does.
        if (browser && flow === "device-code") {
          return { label: "Waiting for you to authorize in the browser", busy: true };
        }
        return codeSubmitted
          ? { label: "Code submitted - waiting for the token…", busy: true }
          : { label: "Waiting for you to authorize in the browser", busy: false };
      case "captured":
        return { label: "Token captured - sealing it into the vault…", busy: true };
      case "verifying":
        return { label: "Sealed in the vault. Checking the token with the provider…", busy: true };
      case "done":
        return { label: "Finished", busy: false };
      case "cancelled":
        return { label: "Cancelled", busy: false };
      case "error":
        return { label: "Failed", busy: false };
      default:
        return { label: String(status?.state ?? ""), busy: true };
    }
  })();

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
          <strong>
            Add {/^[aeiou]/i.test(PLATFORM_SPECS[platform].label) ? "an" : "a"}{" "}
            {PLATFORM_SPECS[platform].label.split(" / ")[0]} account
          </strong>
          <button type="button" className="btn" onClick={onClose} data-testid="account-login-close">
            Close
          </button>
        </div>

        {manualVerify ? (
          <VerifyResult verify={manualVerify} onDone={onClose} />
        ) : !loginId ? (
          <>
            <div className="field">
              <label>platform</label>
              <select
                className="text"
                value={platform}
                data-testid="account-platform"
                onChange={(event) => {
                  const next = event.target.value as AccountPlatform;
                  setPlatform(next);
                  // Each platform offers a different set of mechanisms.
                  setMethod(addMethodsFor(next)[0].id);
                }}
              >
                {ACCOUNT_PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_SPECS[p].label}
                  </option>
                ))}
              </select>
              <span className="hint" style={{ fontSize: 11 }}>
                {/* How this account will be injected depends on the credential
                    shape, not just the platform - say the true one. */}
                {isSubscriptionMethod
                  ? `Runs ${PLATFORM_SPECS[platform].runtimes} in its own ${PLATFORM_SPECS[platform].authFile?.homeEnvKey}, on your subscription.`
                  : platform === "custom"
                    ? "Injected into the env var(s) you name below."
                    : `Injected as ${PLATFORM_SPECS[platform].envKeys.join(" + ")} for ${PLATFORM_SPECS[platform].runtimes}.`}
              </span>
            </div>
            <div className="field">
              <label>account name</label>
              <input
                className="text"
                value={name}
                placeholder="personal / work1 / work2"
                // Slugify as you type rather than rejecting on submit: "ai pro"
                // is a perfectly reasonable thing to type, and the name only has
                // to be safe for env keys, file names and URLs.
                onChange={(event) =>
                  setName(
                    event.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9_-]+/g, "-")
                      .replace(/^-+/, "")
                      .slice(0, 32)
                  )
                }
                data-testid="account-login-name"
              />
            </div>
            <div className="field">
              <label>label (optional)</label>
              <input className="text" value={label} onChange={(event) => setLabel(event.target.value)} />
            </div>
            {/* How the credential gets in. Rendered as a list of real options
                rather than a hidden default, because which mechanisms exist is
                a fact about each CLI and worth seeing. */}
            {methods.length > 1 ? (
              <div className="field" style={{ alignItems: "flex-start" }}>
                <label style={{ paddingTop: 8 }}>method</label>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {methods.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`btn small${method === option.id ? " primary" : ""}`}
                        data-testid={`account-method-${option.id}`}
                        onClick={() => setMethod(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <span className="hint" style={{ fontSize: 11, lineHeight: 1.45 }}>
                    {methods.find((option) => option.id === method)?.blurb}
                  </span>
                </div>
              </div>
            ) : null}
            {platform === "custom" && method === "paste-token" ? (
              <div className="field">
                <label>env var name(s) - comma-separated</label>
                <input
                  className="text"
                  value={envKeysInput}
                  onChange={(event) => setEnvKeysInput(event.target.value)}
                  placeholder="MISTRAL_API_KEY"
                  data-testid="account-env-keys"
                />
              </div>
            ) : null}
            {method === "setup-token" || method === "browser" ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void start()}
                  disabled={starting || !name.trim()}
                  data-testid="account-login-start"
                >
                  {starting ? <Spinner /> : null}
                  {starting
                    ? "Starting…"
                    : method === "browser"
                      ? `Start ${PLATFORM_SPECS[platform].browserLogin?.label.toLowerCase()} (${PLATFORM_SPECS[platform].browserLogin?.command})`
                      : "Start login (claude setup-token)"}
                </button>
              </div>
            ) : method === "import" ? (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void importNative()}
                    disabled={saving || !name.trim()}
                    data-testid="account-import"
                  >
                    {saving ? <Spinner /> : null}
                    {saving ? "Importing…" : `Import from ${PLATFORM_SPECS[platform].nativeLoginPath}`}
                  </button>
                </div>
                {saving ? (
                  <BusyLine label="Sealing this box's login and checking it…" testId="account-manual-busy" />
                ) : null}
              </>
            ) : (
              <>
                {/* Answer "where does this value come from?" BEFORE the field
                    that demands it, not after a failed paste. */}
                {method === "paste-token" ? (
                  <KeyGuide platform={platform} />
                ) : method === "paste-auth" && PLATFORM_SPECS[platform].authFile ? (
                  <div
                    className="hint"
                    style={{
                      border: "1px solid var(--rule)",
                      borderLeft: "3px solid var(--brass, var(--warn))",
                      background: "var(--paper-2, #f7f3ea)",
                      padding: "10px 12px",
                      fontSize: 11.5,
                      lineHeight: 1.5
                    }}
                  >
                    On a machine with a browser, run{" "}
                    <span className="font-mono">{PLATFORM_SPECS[platform].authFile?.loginHint}</span>{" "}
                    and sign in, then paste the contents of{" "}
                    <span className="font-mono">{PLATFORM_SPECS[platform].nativeLoginPath}</span> from
                    that machine below.
                    {PLATFORM_SPECS[platform].browserLogin
                      ? ` Or use "${PLATFORM_SPECS[platform].browserLogin?.label}" above to do it from here.`
                      : ""}
                  </div>
                ) : null}
                <div className="field" style={{ alignItems: "flex-start" }}>
                  <label style={{ paddingTop: 8 }}>
                    {method === "paste-auth" ? "credential file" : "token"}
                  </label>
                  {method === "paste-auth" ? (
                    <textarea
                      className="text font-mono"
                      value={manualToken}
                      onChange={(event) => setManualToken(event.target.value)}
                      placeholder={`contents of ${PLATFORM_SPECS[platform].nativeLoginPath}`}
                      rows={7}
                      style={{ flex: 1, fontSize: 11.5, resize: "vertical" }}
                      data-testid="account-manual-token"
                    />
                  ) : (
                    <input
                      className="text"
                      type="password"
                      value={manualToken}
                      onChange={(event) => setManualToken(event.target.value)}
                      placeholder={PLATFORM_SPECS[platform].tokenHint}
                      data-testid="account-manual-token"
                    />
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void saveManual()}
                    disabled={saving || !manualToken.trim() || !name.trim()}
                    data-testid="account-manual-save"
                  >
                    {saving ? <Spinner /> : null}
                    {saving ? "Sealing…" : "Seal into vault"}
                  </button>
                </div>
                {saving ? (
                  <BusyLine
                    label={
                      platform === "custom"
                        ? "Sealing the token into the vault…"
                        : `Sealing the credential and checking it with ${PLATFORM_SPECS[platform].label.split(" / ")[1] ?? "the provider"}…`
                    }
                    testId="account-manual-busy"
                  />
                ) : null}
              </>
            )}
          </>
        ) : (
          <>
            <div className="hint">
              Running{" "}
              <span className="font-mono">
                {method === "browser" ? PLATFORM_SPECS[platform].browserLogin?.command : "claude setup-token"}
              </span>{" "}
              for account <span className="font-mono">{name}</span>
            </div>
            {/* The live step. Every wait here is a host process or a network
                round trip Garrison cannot shorten, so it must at least move. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                color: phase.busy ? "var(--ink-2)" : "var(--ink)"
              }}
              role="status"
              aria-live="polite"
              data-testid="account-login-phase"
              data-state={status?.state ?? "starting"}
            >
              {phase.busy ? <Spinner /> : null}
              <span>{phase.label}</span>
            </div>
            {status?.authorizeUrl && method === "browser" && PLATFORM_SPECS[platform].browserLogin?.flow === "device-code" ? (
              // Device flow: the browser never talks to this box, so the whole
              // interaction is "open link, type code" - and the code is the
              // thing the user has to carry, so it gets the emphasis.
              <div style={{ border: "1px solid var(--rule)", padding: "12px 14px", background: "white" }}>
                <div style={{ marginBottom: 8 }}>
                  Open this link in a browser signed into the account you want to add - any machine,
                  including your phone:
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <a
                    href={status.authorizeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono"
                    style={{ fontSize: 12.5, wordBreak: "break-all", flex: 1 }}
                    data-testid="account-authorize-url"
                  >
                    {status.authorizeUrl}
                  </a>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      void copyText(status.authorizeUrl ?? "").then((ok) => {
                        setCopied(ok ? "done" : "failed");
                        setTimeout(() => setCopied("idle"), 1800);
                      });
                    }}
                  >
                    {copied === "done" ? "Copied" : copied === "failed" ? "Select it" : "Copy"}
                  </button>
                </div>
                <div className="hint" style={{ marginTop: 10, marginBottom: 4 }}>
                  Then enter this one-time code:
                </div>
                <div
                  className="font-mono"
                  data-testid="account-user-code"
                  style={{
                    fontSize: 26,
                    letterSpacing: "0.18em",
                    fontWeight: 600,
                    padding: "6px 0",
                    userSelect: "all"
                  }}
                >
                  {status.userCode ?? "…"}
                </div>
                <div className="hint" style={{ fontSize: 11 }}>
                  The code expires in 15 minutes. Nothing to paste back - Garrison seals the
                  credential the moment the CLI receives it.
                </div>
              </div>
            ) : status?.authorizeUrl ? (
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
                      void copyText(status.authorizeUrl ?? "").then((ok) => {
                        setCopied(ok ? "done" : "failed");
                        setTimeout(() => setCopied("idle"), 1800);
                      });
                    }}
                  >
                    {copied === "done" ? "Copied" : copied === "failed" ? "Select it" : "Copy"}
                  </button>
                </div>
                <div className="hint" style={{ marginTop: 8 }}>
                  After authorizing, the page shows a code - paste it here:
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <input
                    className="text"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="authorization code"
                    style={{ flex: 1 }}
                    disabled={codeSubmitted}
                    data-testid="account-code-input"
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void submitCode()}
                    disabled={codeSubmitted}
                    data-testid="account-code-submit"
                  >
                    {codeSubmitted ? <Spinner /> : null}
                    {codeSubmitted ? "Submitted" : "Submit code"}
                  </button>
                </div>
              </div>
            ) : null}
            {status?.state === "done" ? (
              <VerifyResult verify={status.verify} onDone={onClose} />
            ) : null}
            {status?.error ? (
              <div className="banner alarm" style={{ marginBottom: 0 }}>
                <span className="glyph">X</span>
                <div style={{ flex: 1 }}>
                  <h5>Login failed</h5>
                  <p>{status.error}</p>
                </div>
              </div>
            ) : null}
            {status?.outputTail ? (
              // Raw CLI output is diagnostic, not the story — collapsed unless
              // something went wrong, so success is a clean panel.
              <details open={status.state === "error"}>
                <summary className="hint" style={{ cursor: "pointer" }}>
                  CLI output
                </summary>
                <pre
                  className="font-mono"
                  style={{
                    fontSize: 10.5,
                    maxHeight: 160,
                    overflowY: "auto",
                    background: "white",
                    border: "1px solid var(--rule)",
                    padding: 8,
                    marginTop: 6,
                    whiteSpace: "pre-wrap"
                  }}
                >
                  {status.outputTail}
                </pre>
              </details>
            ) : null}
          </>
        )}
        {error ? <div style={{ color: "var(--alarm, #a33)" }}>{error}</div> : null}
      </div>
    </div>
  );
}
