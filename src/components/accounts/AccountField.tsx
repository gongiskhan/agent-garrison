"use client";

// AccountField — RUNTIME-ACCOUNTS the compact account picker embedded in the
// runtime config (Compose FacultyStation + Muster Runtimes tab). It SELECTS a
// mode; managing the accounts themselves lives on the dedicated /accounts
// surface (AccountsManager). Modes, per platform:
//
//   Machine login/default key (value "") — use the platform's unpinned source.
//   Auto (value "auto")        — ANTHROPIC ONLY: rotate registered accounts by usage.
//   Pin an account (value <n>) — pin every session to one named account.
//
// The `platform` prop scopes the picker to the runtime's engine: the pin list
// shows only matching-platform accounts, and Auto is hidden off Anthropic (only
// Claude exposes the rate-limit headers rotation depends on).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CHIP_COLOR,
  PLATFORM_SPECS,
  accountOptionLabel,
  accountStatusChip,
  compatibleRuntimeAccounts,
  eligibleRotationCount,
  formatCountdown,
  machineStatusChip,
  runtimeAccountSelectionIssue,
  type AccountInfo,
  type AccountPlatform,
  type PaymasterPayload,
  type PlatformLogin,
  type RuntimeAccountContract
} from "./shared";

// Re-exported for the two call sites that import it alongside AccountField.
export { GenericLoginPanel } from "./LoginDialog";

type Mode = "machine" | "auto" | "pin";

function modeOf(value: string, platform: AccountPlatform): Mode {
  if (value === "auto") return platform === "anthropic" ? "auto" : "pin";
  if (value === "") return "machine";
  return "pin";
}

function ModeButton({
  active,
  label,
  onClick,
  testId
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      style={{
        flex: 1,
        padding: "6px 10px",
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
        border: "1px solid var(--rule)",
        background: active ? "var(--ink)" : "transparent",
        color: active ? "var(--paper, #fdfbf7)" : "var(--ink)",
        whiteSpace: "nowrap"
      }}
    >
      {label}
    </button>
  );
}

export function AccountField({
  value,
  onChange,
  contract
}: {
  value: string;
  onChange: (value: string) => void;
  contract: RuntimeAccountContract;
}) {
  const { platform, emptyMode } = contract;
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [machine, setMachine] = useState<PlatformLogin | null>(null);
  const [pay, setPay] = useState<PaymasterPayload | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Mode is real state (not purely derived): "Pin" with no accounts sets value ""
  // which a pure derivation would read back as Machine login and bounce.
  const [mode, setMode] = useState<Mode>(() => modeOf(value, platform));
  useEffect(() => {
    setMode(modeOf(value, platform));
  }, [value, platform]);

  const refresh = useCallback(async () => {
    try {
      const [a, m, p] = await Promise.all([
        fetch("/api/accounts").then((r) => (r.ok ? r.json() : null)),
        emptyMode === "machine-login"
          ? fetch("/api/accounts/machine-login").then((r) => (r.ok ? r.json() : null))
          : Promise.resolve(null),
        platform === "anthropic"
          ? fetch("/api/accounts/paymaster").then((r) => (r.ok ? r.json() : null))
          : Promise.resolve(null)
      ]);
      if (a?.accounts) setAccounts(a.accounts as AccountInfo[]);
      if (m?.machineLogins) {
        const logins = m.machineLogins as PlatformLogin[];
        setMachine(logins.find((l) => l.platform === platform) ?? null);
      }
      if (p) setPay(p as PaymasterPayload);
      setNow(Date.now());
    } catch {
      /* transient — keep last render */
    }
  }, [platform, emptyMode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const platAccounts = compatibleRuntimeAccounts(accounts, contract);
  const selected = platAccounts.find((account) => account.name === value);
  const issue = runtimeAccountSelectionIssue(value, contract, accounts);
  const hasMachineLogin = emptyMode === "machine-login";
  const defaultModeLabel = hasMachineLogin ? "Machine login" : "Default key";

  const chooseMode = (next: Mode) => {
    setMode(next);
    if (next === "machine") onChange("");
    else if (next === "auto") onChange("auto");
    else if (!value || value === "auto") onChange(platAccounts[0]?.name ?? "");
  };

  const modes: { id: Mode; label: string }[] =
    platform === "anthropic"
      ? [
          { id: "machine", label: "Machine login" },
          { id: "auto", label: "Auto" },
          { id: "pin", label: "Pin an account" }
        ]
      : [
          { id: "machine", label: defaultModeLabel },
          { id: "pin", label: "Pin an account" }
        ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="account-field">
      <div style={{ display: "flex", gap: 0 }} role="group" aria-label="Account mode">
        {modes.map((m) => (
          <ModeButton
            key={m.id}
            active={mode === m.id}
            label={m.label}
            testId={`account-mode-${m.id}`}
            onClick={() => chooseMode(m.id)}
          />
        ))}
      </div>

      {issue ? (
        <div
          className="hint"
          data-testid="account-selection-incompatible"
          style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--alarm)" }}
        >
          {issue.message}{" "}
          <button
            type="button"
            className="btn small"
            data-testid="account-selection-clear"
            onClick={() => onChange("")}
          >
            Clear selection
          </button>
        </div>
      ) : null}

      {mode === "machine" ? (
        <div className="hint" data-testid="account-summary-machine" style={{ fontSize: 12, lineHeight: 1.5 }}>
          {hasMachineLogin ? (
            <>
              Runs under this box&apos;s own {PLATFORM_SPECS[platform].label.split(" / ")[0]} login.{" "}
            </>
          ) : (
            <>
              Uses the unpinned {PLATFORM_SPECS[platform].envKeys.join(" / ") || "provider key"} from the
              Vault/runtime environment.{" "}
            </>
          )}
          {hasMachineLogin && machine ? (
            machine.loggedIn ? (
              <span style={{ color: CHIP_COLOR[machineStatusChip(machine).tone], fontWeight: 600 }}>
                {machine.email ?? "logged in"}
                {machine.plan ? <span style={{ fontWeight: 400 }}> · {machine.plan}</span> : null}
              </span>
            ) : (
              <span style={{ color: CHIP_COLOR[machineStatusChip(machine).tone], fontWeight: 600 }}>
                {machineStatusChip(machine).detail}
              </span>
            )
          ) : hasMachineLogin ? (
            <span>checking…</span>
          ) : null}
        </div>
      ) : null}

      {mode === "auto" ? (
        <div className="hint" data-testid="account-summary-auto" style={{ fontSize: 12, lineHeight: 1.5 }}>
          {platAccounts.length === 0 ? (
            <>
              No Claude accounts registered - Auto falls back to the machine login.{" "}
              <Link href="/accounts">Add accounts</Link> to enable usage-based rotation.
            </>
          ) : pay?.decision.pick ? (
            <>
              Rotates {eligibleRotationCount(platAccounts)} eligible account
              {eligibleRotationCount(platAccounts) === 1 ? "" : "s"} by rate-limit usage · would pick{" "}
              <span className="font-mono" style={{ fontWeight: 600 }}>
                {pay.decision.pick}
              </span>{" "}
              next.
            </>
          ) : (
            <span style={{ color: "var(--alarm)" }}>
              Would HOLD the next spawn - every account is over its ceiling
              {pay?.decision.nearestResetAt
                ? ` (nearest ${formatCountdown(pay.decision.nearestResetAt, now) || "reset pending"})`
                : ""}
              .
            </span>
          )}
        </div>
      ) : null}

      {mode === "pin" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <select
            className="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            data-testid="account-select"
          >
            {platAccounts.length === 0 ? <option value="">no accounts registered</option> : null}
            {platAccounts.map((account) => (
              <option key={account.name} value={account.name}>
                {accountOptionLabel(account)}
              </option>
            ))}
            {value && !selected ? (
              <option value={value}>{issue?.optionLabel ?? `${value} (incompatible)`}</option>
            ) : null}
          </select>
          {selected ? (
            <div className="hint" data-testid="account-summary-pin" style={{ fontSize: 11.5 }}>
              <span style={{ color: CHIP_COLOR[accountStatusChip(selected).tone], fontWeight: 600 }}>
                {accountStatusChip(selected).label}
              </span>{" "}
              · {accountStatusChip(selected).detail}
              {accountStatusChip(selected).tone !== "ok" ? (
                <>
                  {" "}
                  <Link href="/accounts">fix in Accounts</Link>
                </>
              ) : null}
            </div>
          ) : platAccounts.length === 0 ? (
            <div className="hint" style={{ fontSize: 11.5 }}>
              <Link href="/accounts">Add a {PLATFORM_SPECS[platform].label.split(" / ")[0]} account</Link> to
              pin a session to it.
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Link href="/accounts" className="hint" data-testid="account-manage-link" style={{ fontSize: 11.5 }}>
          Manage accounts →
        </Link>
      </div>
    </div>
  );
}
