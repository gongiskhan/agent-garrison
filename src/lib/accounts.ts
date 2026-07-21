// accounts.ts — RUNTIME-ACCOUNTS-V1: the Anthropic account registry.
//
// D1: the TOKEN lives only in the vault (ANTHROPIC_ACCOUNT__<name>); this
// module keeps the non-secret metadata (label, created_at, needs_relogin) in a
// small registry file under the Garrison home. Token values never leave the
// server: listAccounts() returns name/age/status only, and the delivery path
// (accountTokenForSpawn) is audit-recorded like every other vault read.

import fs from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "./claude-home";
import { writeFileAtomic } from "./atomic-write";
import { readVaultSecrets, writeVaultSecrets, vaultStatus, isDevUnlock } from "./vault";
import { recordVaultAccess } from "./vault-audit";
import {
  accountNameFromVaultKey,
  accountVaultKey,
  isValidAccountName,
  looksLikeAnthropicToken
} from "./account-env";

export interface AccountMeta {
  name: string;
  label?: string;
  created_at: string;
  /** Set when a session under this account surfaced an auth failure (D5). */
  needs_relogin?: boolean;
  /** PAYMASTER D7: absent = true. Disabled accounts are never picked by auto. */
  enabled?: boolean;
  /**
   * PAYMASTER D7: utilization ceiling percent (one number, applied to BOTH the
   * 5-hour and weekly windows). Absent = 100.
   */
  ceiling?: number;
}

export const DEFAULT_CEILING = 100;

/** PAYMASTER D8: probe cadence knobs, stored in the registry file. */
export interface PaymasterSettings {
  /** Auto-resolution re-probes an account whose cache is older than this. */
  freshnessTtlMinutes: number;
  /** Background probe interval keeping the panel numbers live. */
  probeIntervalMinutes: number;
}

const DEFAULT_PAYMASTER_SETTINGS: PaymasterSettings = {
  freshnessTtlMinutes: 3,
  probeIntervalMinutes: 10
};

export type AccountStatus = "ready" | "missing-token" | "vault-locked";

export interface AccountInfo extends AccountMeta {
  status: AccountStatus;
  /** Whole days since created_at (token age); null when unknown. */
  ageDays: number | null;
  /** Defaults applied: absent enabled = true, absent ceiling = 100. */
  enabled: boolean;
  ceiling: number;
}

interface RegistryFile {
  version: 1;
  accounts: AccountMeta[];
  paymaster?: {
    freshness_ttl_minutes?: number;
    probe_interval_minutes?: number;
  };
}

function registryPath(): string {
  return path.join(garrisonDir(), "anthropic-accounts.json");
}

async function readRegistry(): Promise<RegistryFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath(), "utf8")) as RegistryFile;
    if (!Array.isArray(parsed.accounts)) return { version: 1, accounts: [] };
    return {
      version: 1,
      accounts: parsed.accounts.filter((a) => a && isValidAccountName(a.name)),
      ...(parsed.paymaster ? { paymaster: parsed.paymaster } : {})
    };
  } catch {
    return { version: 1, accounts: [] };
  }
}

/** Clamp a ceiling percent to a sane 0–100 integer-ish value. */
export function normalizeCeiling(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CEILING;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

/** D8: probe cadence - registry-file overrides over the defaults. */
export async function readPaymasterSettings(): Promise<PaymasterSettings> {
  const registry = await readRegistry();
  const ttl = Number(registry.paymaster?.freshness_ttl_minutes);
  const interval = Number(registry.paymaster?.probe_interval_minutes);
  return {
    freshnessTtlMinutes:
      Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_PAYMASTER_SETTINGS.freshnessTtlMinutes,
    probeIntervalMinutes:
      Number.isFinite(interval) && interval > 0
        ? interval
        : DEFAULT_PAYMASTER_SETTINGS.probeIntervalMinutes
  };
}

async function writeRegistry(registry: RegistryFile): Promise<void> {
  await fs.mkdir(path.dirname(registryPath()), { recursive: true });
  await writeFileAtomic(registryPath(), `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
}

// Registry mutations are read-modify-write on one file. Concurrent mutators -
// e.g. two 401 probes flagging needs_relogin in the same refresh fan-out, or a
// panel PATCH racing a probe flag - would each read the same snapshot and the
// last write would silently drop the other's change. One in-process queue
// serializes them (Garrison is a single server process per instance).
let registryMutationChain: Promise<unknown> = Promise.resolve();

function withRegistryLock<T>(mutation: () => Promise<T>): Promise<T> {
  const run = registryMutationChain.then(mutation, mutation);
  registryMutationChain = run.catch(() => undefined);
  return run;
}

// The vault's account keys, or null when the vault is locked. A locked vault is
// a legitimate resting state — listAccounts degrades to status "vault-locked"
// instead of throwing so the UI can still render the registry.
async function vaultAccountKeys(): Promise<Set<string> | null> {
  if (!vaultStatus().unlocked && !isDevUnlock()) return null;
  try {
    const secrets = await readVaultSecrets();
    return new Set(
      secrets.map((s) => s.key).filter((key) => accountNameFromVaultKey(key) !== null)
    );
  } catch {
    return null;
  }
}

function ageDaysOf(createdAt: string): number | null {
  const ts = Date.parse(createdAt);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 86_400_000));
}

/**
 * All known accounts: registry entries joined with vault presence, PLUS any
 * vault-only ANTHROPIC_ACCOUNT__* entries (e.g. hand-added in the Vault tab)
 * so a token can never hide from the selector just because its metadata is
 * missing. Never returns token values.
 */
export async function listAccounts(): Promise<AccountInfo[]> {
  const registry = await readRegistry();
  const vaultKeys = await vaultAccountKeys();
  const out: AccountInfo[] = registry.accounts.map((meta) => ({
    ...meta,
    status:
      vaultKeys === null
        ? "vault-locked"
        : vaultKeys.has(accountVaultKey(meta.name))
          ? "ready"
          : "missing-token",
    ageDays: ageDaysOf(meta.created_at),
    enabled: meta.enabled !== false,
    ceiling: normalizeCeiling(meta.ceiling ?? DEFAULT_CEILING)
  }));
  if (vaultKeys) {
    const known = new Set(registry.accounts.map((a) => a.name));
    for (const key of vaultKeys) {
      const name = accountNameFromVaultKey(key);
      if (!name || known.has(name)) continue;
      out.push({
        name,
        created_at: "",
        status: "ready",
        ageDays: null,
        enabled: true,
        ceiling: DEFAULT_CEILING
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Add (or replace — D2: re-running for an existing name replaces the token) an
 * account. Writes the token to the vault and the metadata to the registry;
 * created_at is stamped now on every write because a replaced token's age
 * restarts. Throws on an invalid name or a value that is clearly not an
 * Anthropic token.
 */
export function addAccount(options: {
  name: string;
  token: string;
  label?: string;
}): Promise<AccountMeta> {
  return withRegistryLock(() => addAccountLocked(options));
}

async function addAccountLocked(options: {
  name: string;
  token: string;
  label?: string;
}): Promise<AccountMeta> {
  const name = options.name.trim().toLowerCase();
  const token = options.token.trim();
  if (!isValidAccountName(name)) {
    throw new Error(
      `invalid account name "${options.name}" — use 1-32 lowercase letters/digits/dashes/underscores`
    );
  }
  if (!looksLikeAnthropicToken(token)) {
    throw new Error("value does not look like an Anthropic token (expected sk-ant-…)");
  }
  // Defense-in-depth: the registry file is PLAINTEXT. A token mis-pasted into
  // the label field would persist outside the vault and echo to the browser.
  if (options.label && looksLikeAnthropicToken(options.label)) {
    throw new Error("label looks like a token - labels are stored in plaintext; use the token field.");
  }
  const secrets = await readVaultSecrets(); // throws "Vault is locked" — fail loud
  const key = accountVaultKey(name);
  const next = secrets.filter((s) => s.key !== key);
  next.push({ key, value: token });
  await writeVaultSecrets(next);

  const registry = await readRegistry();
  // Re-login replaces the token and restamps created_at, but the account's
  // Paymaster policy (enabled/ceiling) and label survive.
  const prior = registry.accounts.find((a) => a.name === name);
  const meta: AccountMeta = {
    name,
    ...(options.label?.trim()
      ? { label: options.label.trim() }
      : prior?.label
        ? { label: prior.label }
        : {}),
    created_at: new Date().toISOString(),
    ...(prior?.enabled === false ? { enabled: false } : {}),
    ...(prior?.ceiling !== undefined ? { ceiling: prior.ceiling } : {})
  };
  registry.accounts = [...registry.accounts.filter((a) => a.name !== name), meta];
  await writeRegistry(registry);
  return meta;
}

/**
 * PAYMASTER D7/D11: update an account's selection policy (enabled/ceiling) or
 * label. Registry metadata only - never touches the vault. Creates a metadata
 * row for a vault-only account so its policy has somewhere to live.
 */
export function setAccountPolicy(
  name: string,
  patch: { enabled?: boolean; ceiling?: number; label?: string }
): Promise<AccountMeta> {
  return withRegistryLock(() => setAccountPolicyLocked(name, patch));
}

async function setAccountPolicyLocked(
  name: string,
  patch: { enabled?: boolean; ceiling?: number; label?: string }
): Promise<AccountMeta> {
  if (!isValidAccountName(name)) {
    throw new Error(`invalid account name "${name}"`);
  }
  const registry = await readRegistry();
  const existing = registry.accounts.find((a) => a.name === name);
  const base: AccountMeta = existing ?? { name, created_at: "" };
  const next: AccountMeta = { ...base };
  if (patch.enabled !== undefined) {
    if (patch.enabled) delete next.enabled;
    else next.enabled = false;
  }
  if (patch.ceiling !== undefined) {
    const ceiling = normalizeCeiling(patch.ceiling);
    if (ceiling === DEFAULT_CEILING) delete next.ceiling;
    else next.ceiling = ceiling;
  }
  if (patch.label !== undefined) {
    const label = patch.label.trim();
    // Same plaintext-registry guard as addAccount: never store a token shape.
    if (looksLikeAnthropicToken(label)) {
      throw new Error("label looks like a token - labels are stored in plaintext; use the token field.");
    }
    if (label) next.label = label;
    else delete next.label;
  }
  registry.accounts = [...registry.accounts.filter((a) => a.name !== name), next];
  await writeRegistry(registry);
  return next;
}

/** Remove an account: vault token + registry metadata. */
export function removeAccount(name: string): Promise<void> {
  return withRegistryLock(() => removeAccountLocked(name));
}

async function removeAccountLocked(name: string): Promise<void> {
  const key = accountVaultKey(name);
  try {
    const secrets = await readVaultSecrets();
    if (secrets.some((s) => s.key === key)) {
      await writeVaultSecrets(secrets.filter((s) => s.key !== key));
    }
  } catch {
    // Locked vault: still drop the metadata; the orphaned secret resurfaces as
    // a vault-only entry after unlock rather than being silently lost.
  }
  const registry = await readRegistry();
  registry.accounts = registry.accounts.filter((a) => a.name !== name);
  await writeRegistry(registry);
}

/**
 * D5: flag/unflag an account after an observed auth failure (session 401 or
 * Paymaster probe 401). Flagging a vault-only account (no metadata row yet)
 * CREATES its row - a silently unflaggable account would stay a deterministic
 * dead pick for auto selection.
 */
export function setAccountNeedsRelogin(name: string, needsRelogin: boolean): Promise<void> {
  return withRegistryLock(() => setAccountNeedsReloginLocked(name, needsRelogin));
}

async function setAccountNeedsReloginLocked(name: string, needsRelogin: boolean): Promise<void> {
  if (!isValidAccountName(name)) return;
  const registry = await readRegistry();
  let changed = false;
  registry.accounts = registry.accounts.map((a) => {
    if (a.name !== name || Boolean(a.needs_relogin) === needsRelogin) return a;
    changed = true;
    const next = { ...a };
    if (needsRelogin) next.needs_relogin = true;
    else delete next.needs_relogin;
    return next;
  });
  if (needsRelogin && !registry.accounts.some((a) => a.name === name)) {
    registry.accounts = [...registry.accounts, { name, created_at: "", needs_relogin: true }];
    changed = true;
  }
  if (changed) await writeRegistry(registry);
}

/**
 * Audit-recorded token delivery for a spawn (the runner's primary path). The
 * account selector is explicit user config, so a missing token or a locked
 * vault FAILS LOUD — silently launching on the machine's ambient login is
 * exactly the wrong-account bug this feature exists to kill.
 */
export async function accountTokenForSpawn(name: string, consumer: string): Promise<string> {
  const key = accountVaultKey(name);
  let token: string | undefined;
  let locked = false;
  try {
    const secrets = await readVaultSecrets();
    token = secrets.find((s) => s.key === key)?.value;
  } catch {
    locked = true;
  }
  if (!token) {
    await recordVaultAccess({
      connector: consumer,
      secrets: [key],
      action: "denied",
      outcome: "denied",
      detail: locked ? "vault-locked" : "account-token-absent"
    });
    throw new Error(
      locked
        ? `account "${name}" needs ${key} but the vault is LOCKED — unlock it before running.`
        : `account "${name}" has no token in the vault (${key}) — log in again from the runtime config.`
    );
  }
  await recordVaultAccess({ connector: consumer, secrets: [key], action: "deliver", outcome: "ok" });
  return token;
}
