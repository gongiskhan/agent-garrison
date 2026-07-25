"use client";

// AccountsManager — RUNTIME-ACCOUNTS-V2 UX: the dedicated /accounts surface,
// organized into one section PER PLATFORM (Claude/Anthropic · Codex/OpenAI ·
// Gemini/Google · Custom). Each section explains what pinning an account does
// for that engine, shows the box's native login (machine-login mode), lists the
// registered accounts for that platform with a login-status chip + re-login /
// remove, and — for Anthropic only — the always-visible Paymaster policy
// (enabled/ceiling/usage) that `auto` rotates on.
//
// Vault discipline: names, statuses and utilization percentages only — token
// values never reach the browser.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CHIP_COLOR,
  PLATFORM_SECTIONS,
  PLATFORM_SPECS,
  accountStatusChip,
  credentialLabel,
  eligibleRotationCount,
  formatAgo,
  formatCountdown,
  machineStatusChip,
  platformForRuntime,
  type AccountInfo,
  type AccountBalance,
  type AccountPlatform,
  type AddMethod,
  type PaymasterPayload,
  type PlatformLogin,
  type StatusChip,
  type UsageWindow
} from "./shared";
import { LoginDialog } from "./LoginDialog";
import { KeyGuideLink } from "./KeyGuide";

// One stationed runtime of the active composition, reduced to the only thing
// this page cares about: which identity it launches under.
interface RuntimeBinding {
  id: string;
  name: string;
  primary: boolean;
  /** "" = machine login · "auto" = Paymaster rotation · else a pinned account. */
  account: string;
}

function Chip({ chip, testId }: { chip: StatusChip; testId?: string }) {
  return (
    <span
      data-testid={testId}
      title={chip.detail}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.01em",
        color: CHIP_COLOR[chip.tone],
        border: `1px solid ${CHIP_COLOR[chip.tone]}`,
        borderRadius: 999,
        padding: "1px 8px",
        whiteSpace: "nowrap"
      }}
    >
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: CHIP_COLOR[chip.tone] }} />
      {chip.label}
    </span>
  );
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
  const over = win !== null && win.pct >= ceiling;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 130px", minWidth: 120 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
        <span className="hint">{label}</span>
        <span style={over ? { color: "var(--alarm)", fontWeight: 600 } : undefined}>
          {win === null ? "-" : `${win.pct}%`}
        </span>
      </div>
      <div style={{ position: "relative", height: 6, background: "var(--rule, #e2ddd2)", borderRadius: 3, overflow: "hidden" }}>
        {pct !== null ? (
          <div
            style={{
              position: "absolute",
              inset: "0 auto 0 0",
              width: `${pct}%`,
              background: over ? "var(--alarm)" : "var(--ink)",
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
              background: "var(--alarm)",
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

function MachineLoginCard({
  machine,
  platformLabel,
  onAdopt
}: {
  machine: PlatformLogin;
  platformLabel: string;
  /** Present when this platform's login is a file Garrison can adopt. */
  onAdopt?: () => void;
}) {
  const chip = machineStatusChip(machine);
  return (
    <div
      data-testid={`machine-login-card-${machine.platform}`}
      style={{
        border: "1px solid var(--rule)",
        borderLeft: `3px solid ${CHIP_COLOR[chip.tone]}`,
        background: "var(--surface-raised, #fffaf0)",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 6
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12.5 }}>Machine login</strong>
        <Chip chip={chip} testId={`machine-login-chip-${machine.platform}`} />
        <span style={{ flex: 1 }} />
        {onAdopt && machine.loggedIn ? (
          <button
            type="button"
            className="btn small"
            data-testid={`machine-login-adopt-${machine.platform}`}
            onClick={onAdopt}
            title="Copy this login into the vault as a named account you can pin and keep"
          >
            Save as an account
          </button>
        ) : null}
        <span className="hint" style={{ fontSize: 11 }}>
          the box&apos;s own {platformLabel.split(" / ")[0]} login
        </span>
      </div>
      {machine.loggedIn && machine.email ? (
        <span style={{ fontSize: 12.5 }}>
          {machine.email}
          {machine.plan ? <span className="hint"> · {machine.plan}</span> : null}
          {machine.organizationName ? <span className="hint"> · {machine.organizationName}</span> : null}
        </span>
      ) : (
        <span className="hint" style={{ fontSize: 12 }}>{chip.detail}</span>
      )}
      <span className="hint" style={{ fontSize: 10.5, color: "var(--mute)" }}>
        reads <span className="font-mono">{machine.configPath}</span> - Garrison never touches these
        credentials.
      </span>
    </div>
  );
}

// Which identity each stationed runtime launches under - editable here so the
// page answers "and which account does my primary actually use?" without a
// detour through Composition. Writes the same selection[].config the Muster
// picker writes.
function RuntimeBindings({
  platform,
  runtimes,
  accounts,
  onSet
}: {
  platform: AccountPlatform;
  runtimes: RuntimeBinding[];
  accounts: AccountInfo[];
  onSet: (fittingId: string, account: string) => void;
}) {
  if (runtimes.length === 0) return null;
  return (
    <div
      data-testid={`runtime-bindings-${platform}`}
      style={{ border: "1px solid var(--rule)", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12.5 }}>Runtimes on this platform</strong>
        <span className="hint" style={{ fontSize: 11 }}>
          the identity each engine launches under, in the active composition
        </span>
      </div>
      {runtimes.map((runtime) => {
        const missing =
          runtime.account !== "" &&
          runtime.account !== "auto" &&
          !accounts.some((account) => account.name === runtime.account);
        return (
          <div key={runtime.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
              {runtime.id}
            </span>
            {runtime.primary ? <span className="pill">primary</span> : null}
            <span style={{ flex: 1 }} />
            <select
              className="text"
              style={{ minWidth: 230 }}
              value={runtime.account}
              data-testid={`runtime-account-${runtime.id}`}
              onChange={(event) => onSet(runtime.id, event.target.value)}
            >
              <option value="">Machine login (this box)</option>
              {platform === "anthropic" ? <option value="auto">Auto - rotate by usage</option> : null}
              {accounts.map((account) => (
                <option key={account.name} value={account.name}>
                  {account.name}
                  {account.label ? ` (${account.label})` : ""}
                </option>
              ))}
              {/* A pin to a since-removed account must stay visible, not snap
                  silently back to machine login. */}
              {missing ? <option value={runtime.account}>{runtime.account} (missing)</option> : null}
            </select>
          </div>
        );
      })}
    </div>
  );
}

// Credits/spend for an API-key account. Rendered for every key-based account,
// including the ones whose provider refuses to say - "why there is no number" is
// itself the useful answer, and beats an empty space the user has to guess about.
function BalanceLine({ balance, now }: { balance: AccountBalance; now: number }) {
  const known = balance.kind !== "unavailable";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }} data-testid="account-balance">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: known ? 600 : 400, color: known ? "var(--ink)" : "var(--mute)" }}>
          {balance.label}
        </span>
        <span className="hint" style={{ fontSize: 10.5 }}>
          {balance.detail}
          {known ? ` · checked ${formatAgo(balance.fetchedAt, now)}` : ""}
        </span>
      </div>
      {balance.usedPct !== null ? (
        <div style={{ position: "relative", height: 6, background: "var(--rule, #e2ddd2)", borderRadius: 3, overflow: "hidden", maxWidth: 320 }}>
          <div
            style={{
              position: "absolute",
              inset: "0 auto 0 0",
              width: `${Math.min(100, Math.max(0, balance.usedPct))}%`,
              background: balance.usedPct >= 90 ? "var(--alarm)" : "var(--ink)",
              borderRadius: 3
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function AccountRow({
  account,
  candidate,
  balance,
  showPaymaster,
  now,
  onPatch,
  onRelogin,
  onRemove,
  ceilingDraft,
  onCeilingInput
}: {
  account: AccountInfo;
  candidate: PaymasterPayload["decision"]["candidates"][number] | undefined;
  balance: AccountBalance | undefined;
  showPaymaster: boolean;
  now: number;
  onPatch: (name: string, body: { enabled?: boolean; ceiling?: number }) => void;
  onRelogin: (account: AccountInfo) => void;
  onRemove: (name: string) => void;
  ceilingDraft: string;
  onCeilingInput: (name: string, next: string) => void;
}) {
  const chip = accountStatusChip(account);
  const usage = candidate?.usage ?? null;
  return (
    <div
      data-testid={`account-row-${account.name}`}
      style={{
        border: "1px solid var(--rule)",
        borderLeft: `3px solid ${CHIP_COLOR[chip.tone]}`,
        padding: "10px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        opacity: account.enabled ? 1 : 0.7
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span className="font-mono" style={{ fontSize: 13, fontWeight: 600 }}>{account.name}</span>
        {account.label ? <span className="hint" style={{ fontSize: 11.5 }}>{account.label}</span> : null}
        <Chip chip={chip} testId={`account-chip-${account.name}`} />
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" data-testid={`account-relogin-${account.name}`} onClick={() => onRelogin(account)}>
          {chip.tone === "ok" ? "Replace token" : "Add token"}
        </button>
        <button type="button" className="btn danger" data-testid={`account-remove-${account.name}`} onClick={() => onRemove(account.name)}>
          Remove
        </button>
      </div>

      <span className="hint" style={{ fontSize: 10.5 }}>
        {credentialLabel(account)} · {chip.detail}
        {account.platform === "custom" && account.env_keys?.length ? ` · injects ${account.env_keys.join(", ")}` : ""}
        {showPaymaster ? (usage ? ` · probed ${formatAgo(usage.probedAt, now)}` : " · never probed") : ""}
        {usage?.error ? " · STALE (last probe failed)" : ""}
      </span>

      {balance ? <BalanceLine balance={balance} now={now} /> : null}

      {showPaymaster ? (
        <>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
            <label className="hint" style={{ display: "flex", alignItems: "center", gap: 4, paddingTop: 2 }}>
              <input
                type="checkbox"
                checked={account.enabled}
                data-testid={`account-enabled-${account.name}`}
                onChange={(event) => onPatch(account.name, { enabled: event.target.checked })}
              />
              enabled for Auto
            </label>
            <label className="hint" style={{ display: "flex", alignItems: "center", gap: 4, paddingTop: 2 }}>
              ceiling
              <input
                className="text"
                type="number"
                min={0}
                max={100}
                value={ceilingDraft}
                data-testid={`account-ceiling-${account.name}`}
                style={{ width: 58 }}
                onChange={(event) => onCeilingInput(account.name, event.target.value)}
              />
              %
            </label>
            <UsageBar label="5h" window={usage?.fiveHour ?? null} ceiling={account.ceiling} now={now} />
            <UsageBar label="weekly" window={usage?.weekly ?? null} ceiling={account.ceiling} now={now} />
          </div>
          {candidate && !candidate.eligible ? (
            <span style={{ fontSize: 10.5, color: "var(--alarm)" }} data-testid={`account-ineligible-${account.name}`}>
              Auto skips this account: {candidate.reason}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// Reduce the Muster standing model to the runtimes that actually take an
// account. A runtime without an `account` config field (a local engine like
// ollama) has no identity to pick and is left out rather than shown inert.
function runtimeBindings(standing: unknown): RuntimeBinding[] {
  const model = standing as {
    slots?: { faculty: string; fittings?: unknown[] }[];
  };
  const slot = model.slots?.find((entry) => entry.faculty === "runtimes");
  const fittings = (slot?.fittings ?? []) as {
    id: string;
    name: string;
    providesRuntime?: boolean;
    isPrimaryRuntime?: boolean;
    configSchema?: { key: string }[];
    config?: Record<string, unknown>;
  }[];
  return fittings
    .filter((f) => f.providesRuntime && (f.configSchema ?? []).some((field) => field.key === "account"))
    .map((f) => ({
      id: f.id,
      name: f.name,
      primary: Boolean(f.isPrimaryRuntime),
      account: String(f.config?.account ?? "")
    }));
}

export function AccountsManager() {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [machineLogins, setMachineLogins] = useState<PlatformLogin[]>([]);
  const [pay, setPay] = useState<PaymasterPayload | null>(null);
  const [balances, setBalances] = useState<Record<string, AccountBalance>>({});
  const [runtimes, setRuntimes] = useState<RuntimeBinding[]>([]);
  const [probing, setProbing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [dialog, setDialog] = useState<{
    platform: AccountPlatform;
    name: string;
    method?: AddMethod;
  } | null>(null);
  const [ceilingDrafts, setCeilingDrafts] = useState<Record<string, string>>({});
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingCeilingRef = useRef<Record<string, number>>({});

  const load = useCallback(async (refresh = false) => {
    try {
      const [acc, mach, p, standing, bal] = await Promise.all([
        fetch("/api/accounts").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/accounts/machine-login").then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/accounts/paymaster${refresh ? "?refresh=1" : ""}`).then((r) => (r.ok ? r.json() : null)),
        fetch("/api/muster/standing").then((r) => (r.ok ? r.json() : null)),
        // Credits are a live provider round trip - server-cached, and only
        // forced when the user explicitly asks for a refresh.
        fetch(`/api/accounts/balance${refresh ? "?refresh=1" : ""}`).then((r) => (r.ok ? r.json() : null))
      ]);
      if (acc?.accounts) setAccounts(acc.accounts as AccountInfo[]);
      if (mach?.machineLogins) setMachineLogins(mach.machineLogins as PlatformLogin[]);
      if (p) setPay(p as PaymasterPayload);
      if (standing) setRuntimes(runtimeBindings(standing));
      if (bal?.balances) setBalances(bal.balances as Record<string, AccountBalance>);
      setNow(Date.now());
    } catch {
      /* transient - keep last render */
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 60_000);
    const timers = debounceRef.current;
    const pending = pendingCeilingRef.current;
    return () => {
      clearInterval(poll);
      for (const timer of Object.values(timers)) clearTimeout(timer);
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
      } catch {
        /* transient */
      }
    },
    [load]
  );

  const onCeilingInput = useCallback(
    (name: string, next: string) => {
      setCeilingDrafts((drafts) => ({ ...drafts, [name]: next }));
      const prior = debounceRef.current[name];
      if (prior) clearTimeout(prior);
      const pct = Number(next);
      if (next.trim() === "" || !Number.isFinite(pct)) {
        delete pendingCeilingRef.current[name];
        return;
      }
      pendingCeilingRef.current[name] = pct;
      debounceRef.current[name] = setTimeout(() => {
        delete pendingCeilingRef.current[name];
        void patchPolicy(name, { ceiling: pct }).then(() => {
          setCeilingDrafts((drafts) => {
            const { [name]: _saved, ...rest } = drafts;
            return rest;
          });
        });
      }, 600);
    },
    [patchPolicy]
  );

  const removeAccount = useCallback(
    async (name: string) => {
      if (typeof window !== "undefined" && !window.confirm(`Remove account "${name}"? Its vault token is deleted.`)) return;
      try {
        await fetch(`/api/accounts/${encodeURIComponent(name)}`, { method: "DELETE" });
        void load();
      } catch {
        /* transient */
      }
    },
    [load]
  );

  const setRuntimeAccount = useCallback(
    async (fittingId: string, account: string) => {
      // Optimistic: the select must not snap back while the write lands.
      setRuntimes((current) =>
        current.map((runtime) => (runtime.id === fittingId ? { ...runtime, account } : runtime))
      );
      try {
        const response = await fetch("/api/muster/standing/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ faculty: "runtimes", fittingId, key: "account", value: account })
        });
        if (response.ok) setRuntimes(runtimeBindings(await response.json()));
        else void load();
      } catch {
        void load();
      }
    },
    [load]
  );

  const payByName = new Map((pay?.decision.candidates ?? []).map((c) => [c.name, c]));
  const machineByPlatform = new Map(machineLogins.map((m) => [m.platform, m]));

  return (
    <div className="page">
      <div className="head">
        <h1>Accounts</h1>
        <p className="ld">
          The identities your operatives run under, grouped by engine. A runtime launches under one
          of three modes - the box&apos;s own <strong>Machine login</strong>, <strong>Auto</strong>{" "}
          (Claude only - rotates registered accounts by rate-limit usage), or a single{" "}
          <strong>pinned</strong> account. Each section below sets the mode for its runtimes
          directly; the same pickers live on the <Link href="/compose">Composition</Link> page.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 34, maxWidth: 920 }}>
        {PLATFORM_SECTIONS.map((section) => {
          const platAccounts = accounts.filter((a) => a.platform === section.id);
          const machine = machineByPlatform.get(section.id);
          const isAnthropic = section.id === "anthropic";
          const rotationCount = isAnthropic ? eligibleRotationCount(platAccounts) : 0;
          const pick = pay?.decision.pick ?? null;
          const nearest = pay?.decision.nearestResetAt ?? null;
          return (
            <section
              key={section.id}
              data-testid={`account-section-${section.id}`}
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <h2 style={{ fontSize: 18, margin: 0 }}>{section.label}</h2>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn"
                  data-testid={`account-add-${section.id}`}
                  onClick={() => setDialog({ platform: section.id, name: "" })}
                >
                  Add {section.id === "custom" ? "custom" : section.label.split(" / ")[0]} account
                </button>
              </div>
              <p className="hint" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, maxWidth: 760 }}>
                {section.blurb}{" "}
                {/* The route to a key, visible before you open anything. */}
                <KeyGuideLink platform={section.id} />
              </p>

              {machine ? (
                <MachineLoginCard
                  machine={machine}
                  platformLabel={section.label}
                  onAdopt={
                    PLATFORM_SPECS[section.id].authFile
                      ? () => setDialog({ platform: section.id, name: "", method: "import" })
                      : undefined
                  }
                />
              ) : null}

              {isAnthropic ? (
                <div
                  data-testid="paymaster-summary"
                  className="banner info"
                  style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
                >
                  <strong style={{ fontSize: 12.5 }}>Auto rotation</strong>
                  <span style={{ fontSize: 12.5 }}>
                    {platAccounts.length === 0
                      ? "No Claude accounts registered - Auto falls back to the machine login."
                      : pick
                        ? `Rotates ${rotationCount} eligible account${rotationCount === 1 ? "" : "s"} by usage · would pick "${pick}" next.`
                        : `Would HOLD the next spawn - every account is over its ceiling${
                            nearest ? ` (nearest ${formatCountdown(nearest, now) || "reset pending"})` : ""
                          }.`}
                  </span>
                  <span style={{ flex: 1 }} />
                  {platAccounts.length > 0 ? (
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
                  ) : null}
                </div>
              ) : null}

              {platAccounts.length === 0 ? (
                <div className="hint" data-testid={`accounts-empty-${section.id}`} style={{ fontSize: 12 }}>
                  No {section.label.split(" / ")[0]} accounts yet.{" "}
                  <button type="button" className="btn" onClick={() => setDialog({ platform: section.id, name: "" })}>
                    Add one
                  </button>
                </div>
              ) : (
                platAccounts.map((account) => (
                  <AccountRow
                    key={account.name}
                    account={account}
                    candidate={payByName.get(account.name)}
                    balance={balances[account.name]}
                    showPaymaster={isAnthropic}
                    now={now}
                    onPatch={patchPolicy}
                    onRelogin={(a) => setDialog({ platform: a.platform, name: a.name })}
                    onRemove={removeAccount}
                    ceilingDraft={ceilingDrafts[account.name] ?? String(account.ceiling)}
                    onCeilingInput={onCeilingInput}
                  />
                ))
              )}

              <RuntimeBindings
                platform={section.id}
                runtimes={runtimes.filter((runtime) => platformForRuntime(runtime.id) === section.id)}
                accounts={platAccounts}
                onSet={setRuntimeAccount}
              />

              {isAnthropic && pay ? (
                <span className="hint" style={{ fontSize: 10.5 }}>
                  Auto probes each account&apos;s rate-limit headers under its own token - background
                  every {pay.settings.probeIntervalMinutes}m, re-probed at spawn when older than{" "}
                  {pay.settings.freshnessTtlMinutes}m. The <strong>ceiling</strong> is the utilization
                  percent above which Auto stops picking an account (either window).
                </span>
              ) : null}
            </section>
          );
        })}
      </div>

      {dialog ? (
        <LoginDialog
          initialName={dialog.name}
          initialPlatform={dialog.platform}
          initialMethod={dialog.method}
          onClose={() => {
            setDialog(null);
            void load();
          }}
          onAdded={() => void load()}
        />
      ) : null}
    </div>
  );
}
