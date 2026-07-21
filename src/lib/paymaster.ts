// paymaster.ts - RUNTIME-ACCOUNTS-V1 Paymaster: usage-based Anthropic account
// selection for `account: auto` runtime fittings.
//
// D8: usage comes from HEADER PROBES only - a minimal 1-token haiku-class
// /v1/messages call under each account's own token; every response carries the
// anthropic-ratelimit-unified-* family (verified live 2026-07-21, FINDING-A4):
//   anthropic-ratelimit-unified-5h-utilization: 0.46   (fraction of the window)
//   anthropic-ratelimit-unified-5h-reset:       1784659200 (unix seconds)
//   anthropic-ratelimit-unified-5h-status:      allowed
//   anthropic-ratelimit-unified-7d-*            (same trio, weekly window)
//   anthropic-ratelimit-unified-status/-reset/-representative-claim (overall)
// The OAuth usage endpoint is NOT used (setup-tokens lack user:profile - 403).
//
// D7: selection is deterministic, no model in the loop. Per account: enabled +
// ceiling (one percent, BOTH windows). Effective utilization =
// max(5h, weekly); eligible = enabled AND both windows under the ceiling; auto
// picks the lowest effective utilization, tie-break on lower weekly.
//
// D9: when nothing is eligible the resolver HOLDS (PaymasterHoldError carrying
// every account's numbers + the nearest reset) - callers fail the spawn softly
// instead of burning a scorched window.

import fs from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "./claude-home";
import { writeJsonAtomic } from "./atomic-write";
import { readVaultSecrets } from "./vault";
import { accountVaultKey } from "./account-env";
import {
  listAccounts,
  readPaymasterSettings,
  setAccountNeedsRelogin,
  type AccountInfo
} from "./accounts";

// Haiku-class probe per D8: the cheapest request that still returns the
// unified headers. The Claude Code system prompt is required for OAuth
// (setup-token / plan) bearers on /v1/messages.
export const PROBE_MODEL = "claude-haiku-4-5";
const PROBE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
const PROBE_TIMEOUT_MS = 20_000;

export interface UsageWindow {
  /** Utilization percent, 0-100 (headers carry a 0-1 fraction). */
  pct: number;
  /** ISO timestamp of the window reset; null when the header was absent. */
  resetAt: string | null;
  /** Raw header status ("allowed", "rejected", …); null when absent. */
  status: string | null;
}

export interface AccountUsage {
  fiveHour: UsageWindow;
  weekly: UsageWindow;
  /** Overall anthropic-ratelimit-unified-status. */
  status: string | null;
  /** ISO timestamp of the last SUCCESSFUL probe (cache freshness anchor). */
  probedAt: string;
  /** Set when a later probe failed - the numbers above are stale (D8). */
  error?: string;
  errorAt?: string;
}

interface UsageCacheFile {
  version: 1;
  accounts: Record<string, AccountUsage>;
}

function usageCachePath(): string {
  return path.join(garrisonDir(), "paymaster-usage.json");
}

export async function readUsageCache(): Promise<Record<string, AccountUsage>> {
  try {
    const parsed = JSON.parse(await fs.readFile(usageCachePath(), "utf8")) as UsageCacheFile;
    return parsed && typeof parsed.accounts === "object" && parsed.accounts ? parsed.accounts : {};
  } catch {
    return {};
  }
}

async function writeUsageCache(accounts: Record<string, AccountUsage>): Promise<void> {
  await fs.mkdir(garrisonDir(), { recursive: true });
  await writeJsonAtomic(usageCachePath(), { version: 1, accounts } satisfies UsageCacheFile, {
    mode: 0o600
  });
}

// ── header parsing (pure) ────────────────────────────────────────────────────

function parseWindow(get: (name: string) => string | null, prefix: string): UsageWindow | null {
  const utilization = get(`anthropic-ratelimit-unified-${prefix}-utilization`);
  if (utilization === null) return null;
  const fraction = Number(utilization);
  if (!Number.isFinite(fraction)) return null;
  const resetRaw = get(`anthropic-ratelimit-unified-${prefix}-reset`);
  const resetSeconds = Number(resetRaw);
  return {
    pct: Math.round(fraction * 1000) / 10,
    resetAt:
      resetRaw !== null && Number.isFinite(resetSeconds)
        ? new Date(resetSeconds * 1000).toISOString()
        : null,
    status: get(`anthropic-ratelimit-unified-${prefix}-status`)
  };
}

/**
 * Parse the unified ratelimit family from a header lookup. Returns null when
 * the 5h or weekly utilization header is missing (an unusable probe).
 */
export function parseUnifiedHeaders(
  get: (name: string) => string | null,
  now: () => Date = () => new Date()
): AccountUsage | null {
  const fiveHour = parseWindow(get, "5h");
  const weekly = parseWindow(get, "7d");
  if (!fiveHour || !weekly) return null;
  return {
    fiveHour,
    weekly,
    status: get("anthropic-ratelimit-unified-status"),
    probedAt: now().toISOString()
  };
}

// ── probing ──────────────────────────────────────────────────────────────────

export class PaymasterProbeAuthError extends Error {
  constructor(name: string) {
    super(`account "${name}": probe token was rejected (401) - re-login needed.`);
    this.name = "PaymasterProbeAuthError";
  }
}

/**
 * Fire the minimal probe for one account token and parse the headers. The
 * token goes ONLY to Anthropic's own API (hard constraint) and is never
 * logged. A 429 still carries the unified headers and is a VALID probe result
 * (a scorched window is exactly what the Paymaster needs to see).
 */
export async function probeAccountUsage(
  name: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<AccountUsage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        system: PROBE_SYSTEM,
        messages: [{ role: "user", content: "hi" }]
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    throw new PaymasterProbeAuthError(name);
  }
  const usage = parseUnifiedHeaders((header) => response.headers.get(header));
  if (!usage) {
    throw new Error(
      `account "${name}": probe returned ${response.status} without unified ratelimit headers.`
    );
  }
  return usage;
}

// ── cache refresh ────────────────────────────────────────────────────────────

type ProbeOutcome = { ok: true; usage: AccountUsage } | { ok: false; error: string };

interface PaymasterRuntime {
  inFlight: Map<string, Promise<ProbeOutcome>>;
  heartbeat: ReturnType<typeof setInterval> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentGarrisonPaymaster: PaymasterRuntime | undefined;
}

function runtime(): PaymasterRuntime {
  globalThis.__agentGarrisonPaymaster ??= { inFlight: new Map(), heartbeat: null };
  return globalThis.__agentGarrisonPaymaster;
}

/**
 * Bring the usage cache up to date for every ready account whose entry is
 * older than ttlMs (or all of them when force). Probe failures NEVER throw:
 * the account keeps its last numbers with a staleness marker (D8); an
 * auth-rejected probe additionally flags needs-relogin (D5). Reads tokens from
 * the vault directly - a probe is Garrison-internal (the token travels only to
 * Anthropic's own API), so it is not an audited spawn delivery.
 */
export async function refreshUsage(options: {
  ttlMs: number;
  force?: boolean;
  accounts?: AccountInfo[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<Record<string, AccountUsage>> {
  const now = options.now ?? (() => new Date());
  const accounts = options.accounts ?? (await listAccounts());
  const ready = accounts.filter((account) => account.status === "ready");
  const cache = await readUsageCache();

  let tokens: Record<string, string> | null = null;
  try {
    const secrets = await readVaultSecrets();
    tokens = Object.fromEntries(secrets.map((s) => [s.key, s.value]));
  } catch {
    tokens = null; // vault locked - every account keeps its cached numbers
  }

  const due = ready.filter((account) => {
    if (options.force) return true;
    const entry = cache[account.name];
    if (!entry) return true;
    return now().getTime() - Date.parse(entry.probedAt) > options.ttlMs;
  });

  // Concurrent refreshes share one probe per account (inFlight); each caller
  // merges its results over a FRESH disk read at write time. A failed probe
  // only DECORATES whatever entry is freshest at write time with a staleness
  // marker - it never overwrites a sibling caller's newer numbers.
  const updates: Record<string, AccountUsage> = {};
  const failures: Record<string, string> = {};
  await Promise.all(
    due.map(async (account) => {
      const token = tokens?.[accountVaultKey(account.name)];
      if (!token) return;
      const rt = runtime();
      let probe = rt.inFlight.get(account.name);
      if (!probe) {
        probe = (async (): Promise<ProbeOutcome> => {
          try {
            const usage = await probeAccountUsage(account.name, token, options.fetchImpl ?? fetch);
            return { ok: true, usage };
          } catch (error) {
            if (error instanceof PaymasterProbeAuthError) {
              await setAccountNeedsRelogin(account.name, true).catch(() => undefined);
            }
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        })().finally(() => rt.inFlight.delete(account.name));
        rt.inFlight.set(account.name, probe);
      }
      const outcome = await probe;
      if (outcome.ok) {
        updates[account.name] = outcome.usage;
        // A working probe is live proof the token authenticates again - clear
        // a stale needs-relogin flag so auto selection can resume (D5).
        if (account.needs_relogin) {
          await setAccountNeedsRelogin(account.name, false).catch(() => undefined);
        }
      } else {
        failures[account.name] = outcome.error;
      }
    })
  );

  if (Object.keys(updates).length > 0 || Object.keys(failures).length > 0) {
    const onDisk = await readUsageCache();
    const merged = { ...onDisk, ...updates };
    for (const [name, error] of Object.entries(failures)) {
      const freshest = merged[name] ?? cache[name];
      if (freshest) merged[name] = { ...freshest, error, errorAt: now().toISOString() };
    }
    await writeUsageCache(merged);
    return { ...cache, ...merged };
  }
  return cache;
}

/**
 * D8/D11: background probe loop keeping the panel numbers live. Lazy
 * singleton - started from the paymaster API and from up(); safe to call
 * repeatedly. Interval reads the registry's cadence on first start.
 */
export async function ensurePaymasterHeartbeat(): Promise<void> {
  const rt = runtime();
  if (rt.heartbeat) return;
  const settings = await readPaymasterSettings();
  // Re-check after the await: two concurrent callers (panel GET + up()) can
  // both pass the null check above, and the loser's interval would leak.
  if (rt.heartbeat) return;
  const intervalMs = settings.probeIntervalMinutes * 60_000;
  const tick = () => {
    void refreshUsage({ ttlMs: intervalMs / 2 }).catch(() => undefined);
  };
  rt.heartbeat = setInterval(tick, intervalMs);
  rt.heartbeat.unref?.();
  tick();
}

// ── resolution (pure, D7/D9) ─────────────────────────────────────────────────

export interface ResolveCandidate {
  name: string;
  enabled: boolean;
  /** Percent ceiling applied to BOTH windows (D7). */
  ceiling: number;
  /** Token present in an unlocked vault. */
  tokenReady: boolean;
  /**
   * D5: an observed auth failure (session 401 or probe 401). A revoked token
   * keeps 401ing while its cached numbers stay frozen at the last good values,
   * so without this the dead account would become the deterministic pick.
   */
  needsRelogin: boolean;
  usage: AccountUsage | null;
}

/** The single canonical AccountInfo+usage -> candidates mapping (all callers). */
export function candidatesFrom(
  accounts: AccountInfo[],
  usage: Record<string, AccountUsage>
): ResolveCandidate[] {
  return accounts.map((account) => ({
    name: account.name,
    enabled: account.enabled,
    ceiling: account.ceiling,
    tokenReady: account.status === "ready",
    needsRelogin: Boolean(account.needs_relogin),
    usage: usage[account.name] ?? null
  }));
}

export interface JudgedCandidate extends ResolveCandidate {
  /** max(5h, weekly) percent; null without usage. */
  effectivePct: number | null;
  eligible: boolean;
  /** Why this candidate is ineligible; null when eligible. */
  reason: string | null;
}

export interface PaymasterDecision {
  pick: string | null;
  candidates: JudgedCandidate[];
  /** Nearest window reset among ceiling-blocked accounts (D9 hold hint). */
  nearestResetAt: string | null;
}

/**
 * D7: deterministic selection. Eligible = enabled AND token ready AND usage
 * known AND both windows strictly under the ceiling. Pick = lowest effective
 * utilization (max of the two windows); tie-break on lower weekly, then name.
 * A cool 5h window on a scorched weekly scores high and is skipped.
 */
export function resolvePaymaster(candidates: ResolveCandidate[]): PaymasterDecision {
  const judged: JudgedCandidate[] = candidates.map((candidate) => {
    const { usage } = candidate;
    let reason: string | null = null;
    if (!candidate.enabled) reason = "disabled";
    else if (!candidate.tokenReady) reason = "no token (vault locked or absent)";
    else if (candidate.needsRelogin) reason = "needs re-login (auth failure observed)";
    else if (!usage) reason = "no usage data (probe failed, no cache)";
    else if (usage.fiveHour.pct >= candidate.ceiling || usage.weekly.pct >= candidate.ceiling) {
      reason = `over ceiling (5h ${usage.fiveHour.pct}% / weekly ${usage.weekly.pct}% vs ${candidate.ceiling}%)`;
    }
    return {
      ...candidate,
      effectivePct: usage ? Math.max(usage.fiveHour.pct, usage.weekly.pct) : null,
      eligible: reason === null,
      reason
    };
  });

  const eligible = judged
    .filter((candidate) => candidate.eligible)
    .sort((left, right) => {
      const byEffective = (left.effectivePct ?? 0) - (right.effectivePct ?? 0);
      if (byEffective !== 0) return byEffective;
      const byWeekly = (left.usage?.weekly.pct ?? 0) - (right.usage?.weekly.pct ?? 0);
      if (byWeekly !== 0) return byWeekly;
      return left.name.localeCompare(right.name);
    });

  const resets = judged
    .filter((candidate) => candidate.usage && candidate.reason?.startsWith("over ceiling"))
    .flatMap((candidate) => {
      const { usage, ceiling } = candidate;
      const out: string[] = [];
      if (usage && usage.fiveHour.pct >= ceiling && usage.fiveHour.resetAt) {
        out.push(usage.fiveHour.resetAt);
      }
      if (usage && usage.weekly.pct >= ceiling && usage.weekly.resetAt) {
        out.push(usage.weekly.resetAt);
      }
      return out;
    })
    .sort();

  return {
    pick: eligible[0]?.name ?? null,
    candidates: judged,
    nearestResetAt: resets[0] ?? null
  };
}

/** One line per account for the run log / hold message. Never includes tokens. */
export function formatDecisionLines(decision: PaymasterDecision): string[] {
  return decision.candidates.map((candidate) => {
    const usage = candidate.usage;
    const numbers = usage
      ? `5h ${usage.fiveHour.pct}% (reset ${usage.fiveHour.resetAt ?? "?"}) / weekly ${usage.weekly.pct}% (reset ${usage.weekly.resetAt ?? "?"})${usage.error ? " [STALE: last probe failed]" : ""}`
      : "no usage data";
    const verdict = candidate.eligible ? "eligible" : `skipped: ${candidate.reason}`;
    return `${candidate.name}: ${numbers} · ceiling ${candidate.ceiling}% · ${verdict}`;
  });
}

export class PaymasterHoldError extends Error {
  readonly decision: PaymasterDecision;
  constructor(decision: PaymasterDecision) {
    const lines = formatDecisionLines(decision);
    super(
      `Paymaster HOLD (D9): no account is eligible - not starting on a scorched window.\n` +
        lines.map((line) => `  ${line}`).join("\n") +
        (decision.nearestResetAt
          ? `\n  Nearest reset: ${decision.nearestResetAt}. Pin an account to override.`
          : `\n  Pin an account to override.`)
    );
    this.name = "PaymasterHoldError";
    this.decision = decision;
  }
}

export type AutoResolution =
  | {
      /** No accounts registered at all - fall back to the machine's login. */
      mode: "machine-login";
      decision: null;
    }
  | { mode: "account"; name: string; decision: PaymasterDecision };

/**
 * Resolve `account: auto` for a spawn (D7/D8/D9). Probes accounts whose cache
 * is older than the freshness TTL, then applies the deterministic resolver.
 * Zero registered accounts fall back to the machine login (a fresh install
 * must keep launching); one or more registered accounts with nothing eligible
 * HOLDS via PaymasterHoldError. Token delivery stays with the caller
 * (accountTokenForSpawn) so the audited-delivery path is single.
 */
export async function resolveAutoAccount(options?: {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<AutoResolution> {
  const accounts = await listAccounts();
  if (accounts.length === 0) return { mode: "machine-login", decision: null };
  const settings = await readPaymasterSettings();
  const cache = await refreshUsage({
    ttlMs: settings.freshnessTtlMinutes * 60_000,
    accounts,
    fetchImpl: options?.fetchImpl,
    now: options?.now
  });
  // Re-list AFTER the refresh: a successful probe may have just cleared (or a
  // 401 probe set) needs_relogin, and eligibility must see the current flags.
  const refreshed = await listAccounts();
  const decision = resolvePaymaster(candidatesFrom(refreshed, cache));
  if (!decision.pick) throw new PaymasterHoldError(decision);
  return { mode: "account", name: decision.pick, decision };
}
