// accounts.ts — RUNTIME-ACCOUNTS-V1: the Anthropic account registry.
//
// D1: the TOKEN lives only in the vault (ANTHROPIC_ACCOUNT__<name>); this
// module keeps the non-secret metadata (label, created_at, needs_relogin) in a
// small registry file under the Garrison home. Token values never leave the
// server: listAccounts() returns name/age/status only, and the delivery path
// (accountTokenForSpawn) is audit-recorded like every other vault read.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { garrisonDir } from "./claude-home";
import { writeFileAtomic } from "./atomic-write";
import { readVaultSecrets, writeVaultSecrets, vaultStatus, isDevUnlock } from "./vault";
import { recordVaultAccess } from "./vault-audit";
import {
  accountAuthEnv,
  accountHomeEnv,
  accountNameFromVaultKey,
  accountVaultKey,
  isValidAccountName,
  isValidEnvKey,
  looksLikeAnthropicToken,
  normalizeCredentialKind,
  normalizePlatform,
  parseAccountVaultKey,
  parseAuthFile,
  ACCOUNT_PLATFORMS,
  PLATFORM_SPECS,
  type AccountPlatform,
  type CredentialKind
} from "./account-env";

export interface AccountMeta {
  name: string;
  label?: string;
  created_at: string;
  /**
   * RUNTIME-ACCOUNTS-V2: which engine family this account authenticates
   * (anthropic/openai/google/custom). Absent = anthropic (legacy rows).
   */
  platform?: AccountPlatform;
  /**
   * RUNTIME-ACCOUNTS-V3: `token` (env-var API key, the default and every legacy
   * row) or `auth-file` (a subscription OAuth credential file materialized into
   * a per-account config home). Absent = token.
   */
  credential_kind?: CredentialKind;
  /** Custom-platform only: the env var name(s) the token is injected as. */
  env_keys?: string[];
  /** Set when a session under this account surfaced an auth failure (D5). */
  needs_relogin?: boolean;
  /**
   * RUNTIME-ACCOUNTS-V4: the last verification verdict. Kept because some
   * verdicts outlive the dialog that produced them - an account can be perfectly
   * logged in and still unusable (a Google login with no Gemini Code Assist
   * entitlement, a plan account at its limit), and the roster has to be able to
   * say why without re-probing.
   */
  last_verify?: { outcome: string; detail: string; at: string };
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
  /** Resolved (never absent) — legacy rows normalize to anthropic. */
  platform: AccountPlatform;
  /** Resolved (never absent) — legacy rows normalize to token. */
  credential_kind: CredentialKind;
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
  return path.join(garrisonDir(), "accounts.json");
}

// RUNTIME-ACCOUNTS-V2 rename: the registry is no longer Anthropic-only. Read the
// new generic file; fall back to the legacy `anthropic-accounts.json` (the next
// write persists the new name). No data is lost on the rename.
function legacyRegistryPath(): string {
  return path.join(garrisonDir(), "anthropic-accounts.json");
}

async function readRegistry(): Promise<RegistryFile> {
  const parse = async (file: string): Promise<RegistryFile | null> => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as RegistryFile;
      if (!Array.isArray(parsed.accounts)) return { version: 1, accounts: [] };
      return {
        version: 1,
        // Normalize the platform on read so downstream code never re-derives it;
        // legacy rows (no platform) become anthropic.
        accounts: parsed.accounts
          .filter((a) => a && isValidAccountName(a.name))
          .map((a) => ({
            ...a,
            platform: normalizePlatform(a.platform),
            credential_kind: normalizeCredentialKind(a.credential_kind)
          })),
        ...(parsed.paymaster ? { paymaster: parsed.paymaster } : {})
      };
    } catch {
      return null;
    }
  };
  return (await parse(registryPath())) ?? (await parse(legacyRegistryPath())) ?? { version: 1, accounts: [] };
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
  const out: AccountInfo[] = registry.accounts.map((meta) => {
    const platform = normalizePlatform(meta.platform);
    return {
      ...meta,
      platform,
      credential_kind: normalizeCredentialKind(meta.credential_kind),
      status:
        vaultKeys === null
          ? "vault-locked"
          : vaultKeys.has(accountVaultKey(meta.name, platform))
            ? "ready"
            : "missing-token",
      ageDays: ageDaysOf(meta.created_at),
      enabled: meta.enabled !== false,
      ceiling: normalizeCeiling(meta.ceiling ?? DEFAULT_CEILING)
    };
  });
  if (vaultKeys) {
    // Discover vault-only accounts (hand-added tokens with no metadata row) by
    // parsing every account-shaped key back to { name, platform }. Account names
    // are globally unique, so a registry row for a name suppresses any vault-only
    // key of the same name.
    const known = new Set(registry.accounts.map((a) => a.name));
    for (const key of vaultKeys) {
      const parsed = parseAccountVaultKey(key);
      if (!parsed || known.has(parsed.name)) continue;
      out.push({
        name: parsed.name,
        platform: parsed.platform,
        credential_kind: "token",
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
export interface AddAccountOptions {
  name: string;
  /** The credential VALUE: an API key, or the whole auth-file JSON document. */
  token: string;
  label?: string;
  platform?: AccountPlatform;
  /** RUNTIME-ACCOUNTS-V3: token (default) or auth-file. */
  credential_kind?: CredentialKind;
  /** Custom platform: the env var name(s) the token is injected as. */
  env_keys?: string[];
}

export function addAccount(options: AddAccountOptions): Promise<AccountMeta> {
  return withRegistryLock(() => addAccountLocked(options));
}

async function addAccountLocked(options: AddAccountOptions): Promise<AccountMeta> {
  const name = options.name.trim().toLowerCase();
  const kind = normalizeCredentialKind(options.credential_kind);
  // An auth-file is a JSON document — trimming is safe, but its internal
  // whitespace is not ours to touch.
  const token = kind === "auth-file" ? options.token.trim() : options.token.trim();
  const platform = normalizePlatform(options.platform);
  if (!isValidAccountName(name)) {
    throw new Error(
      `invalid account name "${options.name}" — use 1-32 lowercase letters/digits/dashes/underscores`
    );
  }
  if (!token) {
    throw new Error(kind === "auth-file" ? "credential file is empty" : "token is empty");
  }
  if (kind === "auth-file") {
    if (!PLATFORM_SPECS[platform].authFile) {
      throw new Error(`${platform} accounts have no subscription-credential file — use a token`);
    }
    const parsed = parseAuthFile(platform, token);
    if (!parsed.ok) throw new Error(parsed.error);
  }
  // Anthropic tokens have a recognizable shape; other platforms are opaque, so
  // only guard against an obviously-wrong Anthropic paste there.
  if (kind === "token" && platform === "anthropic" && !looksLikeAnthropicToken(token)) {
    throw new Error("value does not look like an Anthropic token (expected sk-ant-…)");
  }
  // Custom platform must declare where to inject the token.
  let envKeys: string[] | undefined;
  if (platform === "custom" && kind === "token") {
    envKeys = (options.env_keys ?? []).map((k) => k.trim()).filter(Boolean);
    if (envKeys.length === 0) {
      throw new Error("custom accounts need at least one env var name (e.g. MISTRAL_API_KEY)");
    }
    const bad = envKeys.find((k) => !isValidEnvKey(k));
    if (bad) throw new Error(`invalid env var name "${bad}" — use letters, digits and underscores`);
  }
  // Defense-in-depth: the registry file is PLAINTEXT. A token mis-pasted into
  // the label field would persist outside the vault and echo to the browser.
  if (options.label && (looksLikeAnthropicToken(options.label) || options.label.trim() === token)) {
    throw new Error("label looks like a token - labels are stored in plaintext; use the token field.");
  }
  const secrets = await readVaultSecrets(); // throws "Vault is locked" — fail loud
  const key = accountVaultKey(name, platform);

  const registry = await readRegistry();
  // Re-login replaces the token and restamps created_at, but the account's
  // Paymaster policy (enabled/ceiling) and label survive.
  const prior = registry.accounts.find((a) => a.name === name);

  // Account names are globally unique, so re-using one across platforms used to
  // DESTROY the other account silently - registry row and vault token both
  // (observed live 2026-07-25: adding a Hugging Face key named "a" deleted an
  // OpenRouter account of the same name). Replacing a credential in place is
  // legitimate; quietly discarding a different provider's is not. Check the
  // vault too, so a vault-only account of the same name is equally protected.
  const clashPlatform =
    prior && normalizePlatform(prior.platform) !== platform
      ? normalizePlatform(prior.platform)
      : (secrets
          .map((secret) => parseAccountVaultKey(secret.key))
          .find((parsed) => parsed && parsed.name === name && parsed.platform !== platform)
          ?.platform ?? null);
  if (clashPlatform) {
    throw new Error(
      `an account named "${name}" already exists on ${PLATFORM_SPECS[clashPlatform].label} - ` +
        `account names are shared across providers. Pick a different name, or remove that account first.`
    );
  }

  const next = secrets.filter((s) => s.key !== key);
  next.push({ key, value: token });
  await writeVaultSecrets(next);

  const meta: AccountMeta = {
    name,
    ...(platform !== "anthropic" ? { platform } : {}),
    ...(kind === "auth-file" ? { credential_kind: kind } : {}),
    ...(envKeys ? { env_keys: envKeys } : {}),
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
 * RUNTIME-ACCOUNTS-V3: the config home a subscription account is materialized
 * into. One directory per (platform, account) under the instance's Garrison
 * home, so two Codex accounts never share `auth.json` and neither touches the
 * box's own `~/.codex`.
 */
export function accountHomeDir(name: string, platform: AccountPlatform): string {
  return path.join(garrisonDir(), "runtime-homes", "accounts", `${platform}-${name}`);
}

/**
 * Write a sealed subscription credential into its per-account config home and
 * return the home path (what CODEX_HOME / GEMINI_CLI_HOME is set to).
 *
 * The CLI OWNS this file once it is there: codex and gemini both rotate the
 * refresh token and rewrite it in place. Re-writing from the vault on every
 * spawn would hand the CLI back a superseded credential, so the write is
 * content-addressed — it happens only when the vault copy actually changed
 * (a fresh login, a re-import), never on a routine launch.
 */
export async function materializeAccountHome(
  name: string,
  platform: AccountPlatform,
  content: string
): Promise<string> {
  const spec = PLATFORM_SPECS[platform].authFile;
  if (!spec) throw new Error(`${platform} accounts have no credential file to materialize`);
  const home = accountHomeDir(name, platform);
  const file = path.join(home, spec.relPath);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256").update(content).digest("hex");
  const stampPath = path.join(home, ".garrison-credential");
  const stamp = await fs.readFile(stampPath, "utf8").catch(() => "");
  if (stamp.trim() !== hash || !existsSync(file)) {
    await writeFileAtomic(file, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o600 });
    await writeFileAtomic(stampPath, `${hash}\n`, { mode: 0o600 });
  }
  // Companions make the home usable at all (Gemini's auth-type selector). Never
  // overwritten - the CLI may rewrite them with richer state on first run.
  for (const companion of spec.companionFiles ?? []) {
    const target = path.join(home, companion.relPath);
    if (existsSync(target)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFileAtomic(target, `${JSON.stringify(companion.json, null, 2)}\n`, { mode: 0o600 });
  }
  return home;
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
  try {
    const secrets = await readVaultSecrets();
    // Drop every account-shaped key that parses back to this name (any platform),
    // so a platform-migrated or vault-only token can't orphan.
    const filtered = secrets.filter((s) => parseAccountVaultKey(s.key)?.name !== name);
    if (filtered.length !== secrets.length) await writeVaultSecrets(filtered);
  } catch {
    // Locked vault: still drop the metadata; the orphaned secret resurfaces as
    // a vault-only entry after unlock rather than being silently lost.
  }
  const registry = await readRegistry();
  registry.accounts = registry.accounts.filter((a) => a.name !== name);
  await writeRegistry(registry);
  // A materialized subscription home holds a live credential on disk — removing
  // the account must remove it too, or the token outlives its own registry row.
  for (const platform of ACCOUNT_PLATFORMS) {
    if (!PLATFORM_SPECS[platform].authFile) continue;
    await fs.rm(accountHomeDir(name, platform), { recursive: true, force: true }).catch(
      () => undefined
    );
  }
}

/** Record the last verification verdict (see AccountMeta.last_verify). */
export function setAccountVerdict(
  name: string,
  verdict: { outcome: string; detail: string; at: string }
): Promise<void> {
  return withRegistryLock(async () => {
    if (!isValidAccountName(name)) return;
    const registry = await readRegistry();
    const existing = registry.accounts.find((a) => a.name === name);
    const base: AccountMeta = existing ?? { name, created_at: "" };
    registry.accounts = [
      ...registry.accounts.filter((a) => a.name !== name),
      { ...base, last_verify: verdict }
    ];
    await writeRegistry(registry);
  });
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
export async function accountTokenForSpawn(
  name: string,
  consumer: string,
  platform: AccountPlatform = "anthropic"
): Promise<string> {
  const key = accountVaultKey(name, platform);
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

/**
 * RUNTIME-ACCOUNTS-V2: build the spawn-env for every composed runtime's pinned,
 * NON-ANTHROPIC account. Anthropic is deliberately excluded here — it flows
 * through the dedicated primary path (buildPrimaryRuntimeEnv + the auto/Paymaster
 * resolution), and its env var is process-wide so a secondary Anthropic delegate
 * must ride the operative's token, never clobber it. OpenAI/Google/custom use
 * disjoint env vars, so injecting them into the operative env lets a Codex/Gemini
 * runtime authenticate whether it is the primary or a secondary delegate target
 * (the bridge inherits process.env). Missing tokens are logged, never fatal —
 * the delegate fails loudly at call time with its own vault-locked/absent error.
 */
export async function resolveRuntimeAccountEnv(
  runtimes: { id: string; account?: string }[],
  opts?: { log?: (message: string) => void }
): Promise<Record<string, string>> {
  const log = opts?.log ?? (() => undefined);
  const accounts = await listAccounts();
  const byName = new Map(accounts.map((a) => [a.name, a]));
  const env: Record<string, string> = {};
  for (const runtime of runtimes) {
    const account = String(runtime.account ?? "").trim();
    if (!account || account === "auto") continue; // "" = machine login; auto = anthropic-only
    const meta = byName.get(account);
    if (!meta) {
      log(`runtime ${runtime.id}: account "${account}" is not in the registry — ignored.`);
      continue;
    }
    if (meta.platform === "anthropic") continue; // handled by the primary/auto path
    try {
      const secret = await accountTokenForSpawn(account, runtime.id, meta.platform);
      if (meta.credential_kind === "auth-file") {
        // Subscription credential: hand the CLI a private config home instead of
        // an env token. This OVERRIDES the launcher's instance-wide CODEX_HOME /
        // GEMINI_CLI_HOME for the pinned account.
        const home = await materializeAccountHome(account, meta.platform, secret);
        Object.assign(env, accountHomeEnv(account, meta.platform, home));
        const spec = PLATFORM_SPECS[meta.platform].authFile!;
        log(`runtime ${runtime.id}: injected ${meta.platform} account "${account}" (${spec.homeEnvKey}=${home}).`);
      } else {
        Object.assign(env, accountAuthEnv(account, secret, meta.platform, meta.env_keys));
        const keys = meta.platform === "custom" ? meta.env_keys ?? [] : PLATFORM_SPECS[meta.platform].envKeys;
        log(`runtime ${runtime.id}: injected ${meta.platform} account "${account}" (${keys.join(", ")}).`);
      }
    } catch (error) {
      log(`runtime ${runtime.id}: account "${account}" token unavailable — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return env;
}
