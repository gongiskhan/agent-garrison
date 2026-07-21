// Primary-runtime selection + provider-env resolution.
//
// A composition's Runtime Faculty may hold several runtime fittings, but exactly
// ONE runs the orchestrator loop — the PRIMARY runtime (named by
// GlobalConfig.primary_runtime; defaults to the Claude Code runtime). The others
// are secondary delegate targets surfaced through the model-router.
//
// This module is the small, pure decision layer the runner uses to decide WHICH
// engine to spawn and WITH WHICH provider env. It is deliberately decoupled from
// the heavy runner internals so it can be unit-tested in isolation.
import type { CapabilityProvision } from "./types";
import { accountAuthEnv, accountVaultKey } from "./account-env";

/** The default primary runtime when GlobalConfig.primary_runtime is unset. */
export const DEFAULT_PRIMARY_RUNTIME = "claude-code-runtime";

/** A composed Runtime-Faculty fitting, reduced to what selection needs. */
export interface RuntimeEntry {
  id: string;
  /** The fitting's declared `provides` (used to derive the engine). */
  provides: CapabilityProvision[];
  /** The per-fitting selection config (provider/model/base_url, …). */
  config?: Record<string, string | number | boolean>;
}

export interface PrimaryRuntimeDescriptor {
  /** The runtime fitting id that hosts the orchestrator. */
  runtimeId: string;
  /**
   * The engine name — the `runtime` capability's provided name
   * (e.g. "claude-code", "agent-sdk"). Drives the spawn strategy.
   */
  engine: string;
  /** True when resolved from the implicit default (no explicit/composed primary). */
  isDefault: boolean;
  /** The primary fitting's selection config (empty for the implicit default). */
  config: Record<string, string | number | boolean>;
}

/**
 * A provider entry from the policy's `providers` section (GARRISON-RUNTIMES-V1
 * P2/D2: providers are POLICY DATA, not code). The historical PRIMARY_PROVIDERS
 * mirror of the orchestrator registry is gone — the runner supplies the policy
 * section (migration-seeded for pre-P2 configs) to buildPrimaryRuntimeEnv.
 */
export interface PolicyProvider {
  id: string;
  kind?: string;
  baseUrl?: string | null;
  vaultKey?: string;
  dummyToken?: string;
  notes?: string;
}

function engineOf(entry: RuntimeEntry): string {
  const runtimeProvision = entry.provides.find((p) => p.kind === "runtime");
  // Fall back to the fitting id when a runtime fitting omits the provided name
  // (shouldn't happen for a well-formed runtime fitting, but never crash here).
  return runtimeProvision?.name ?? entry.id;
}

/**
 * Resolve which composed runtime runs the orchestrator.
 *
 * - Unset / "claude-code-runtime" → the default Claude Code engine. If that
 *   fitting is not explicitly composed, a synthetic default descriptor is
 *   returned (engine "claude-code") so today's gateway/PTY behavior is preserved
 *   even when no Runtime-Faculty fitting is selected.
 * - A named, composed runtime → its descriptor (engine derived from `provides`).
 * - A named runtime that is NOT composed → throws (fail loud; never silently
 *   fall back to a different engine).
 */
export function resolvePrimaryRuntime(opts: {
  primaryRuntimeId?: string;
  runtimeEntries: RuntimeEntry[];
}): PrimaryRuntimeDescriptor {
  const { runtimeEntries } = opts;
  const explicit = (opts.primaryRuntimeId ?? "").trim();
  const desiredId = explicit || DEFAULT_PRIMARY_RUNTIME;
  const match = runtimeEntries.find((e) => e.id === desiredId);

  if (!match) {
    // Synthesize the implicit default ONLY when no primary was explicitly named.
    // The Claude Code engine runs via the gateway/PTY even without its fitting
    // composed, so an UNSET primary safely defaults to it. But an EXPLICIT
    // primary_runtime that isn't composed is a config error — its provider/model
    // config would be silently lost — so fail loud (incl. for the default id).
    if (!explicit) {
      return { runtimeId: DEFAULT_PRIMARY_RUNTIME, engine: "claude-code", isDefault: true, config: {} };
    }
    throw new Error(
      `primary_runtime "${desiredId}" is not a composed Runtime-Faculty fitting; ` +
        `compose it under the Runtimes faculty, or leave primary_runtime unset to use the default Claude Code runtime.`
    );
  }

  return {
    runtimeId: match.id,
    engine: engineOf(match),
    isDefault: desiredId === DEFAULT_PRIMARY_RUNTIME,
    config: match.config ?? {}
  };
}

export interface PrimaryRuntimeEnv {
  /** Env vars to merge into the orchestrator spawn. */
  env: Record<string, string>;
  /**
   * True when a non-default provider base URL is in play — the claude-pty spawn
   * must keep ANTHROPIC_BASE_URL/AUTH_TOKEN (providerLaunch) instead of stripping
   * them for the Max-plan default.
   */
  providerLaunch: boolean;
  /**
   * RUNTIME-ACCOUNTS-V1: the Anthropic account this launch is pinned to, when
   * the fitting config selects one on the plan path (non-secret marker for the
   * runner's log line). Absent on provider launches and unpinned launches.
   */
  account?: string;
}

/**
 * Build the orchestrator spawn env for the resolved primary runtime.
 *
 * Behaviour-preserving by construction: with the default provider
 * (anthropic-plan) and no explicit model, only harmless marker vars are set, so
 * the historical spawn behavior is unchanged. A non-default provider swaps
 * ANTHROPIC_BASE_URL and supplies the auth token (dummy for local, vault key for
 * cloud) so the SAME engine runs against that provider; a cloud provider with a
 * missing/locked vault key throws (fail loud).
 *
 * @param secretLookup resolve a vault key → its value (or undefined if absent/locked).
 * @param providers the policy's providers section (REQUIRED — P2; the runner
 *   resolves it from the routing config, migration-seeded when absent there).
 */
export function buildPrimaryRuntimeEnv(
  descriptor: PrimaryRuntimeDescriptor,
  secretLookup: (vaultKey: string) => string | undefined,
  providers: PolicyProvider[]
): PrimaryRuntimeEnv {
  const config = descriptor.config;
  const env: Record<string, string> = {
    GARRISON_PRIMARY_RUNTIME: descriptor.runtimeId,
    GARRISON_PRIMARY_ENGINE: descriptor.engine
  };

  // Only override the model when explicitly configured — otherwise leave the
  // existing GARRISON_MODEL default (gateway.config.model ?? "opus") untouched.
  if (config.model !== undefined && String(config.model).length > 0) {
    env.GARRISON_MODEL = String(config.model);
  }

  // The providers section is REQUIRED on every path — including the default
  // anthropic-plan one, which needs no provider data but must still fail loud
  // when the call-site plumbing is broken (matching stage-b's buildLaunchEnv;
  // a silent default-path pass would mask the bug until a provider flip).
  if (!Array.isArray(providers) || !providers.length) {
    throw new Error(
      `primary runtime ${descriptor.runtimeId}: no providers section supplied — ` +
        `pass the policy's providers (providers are policy data, P2).`
    );
  }

  // RUNTIME-ACCOUNTS-V1: the plan path may be pinned to a named account. The
  // token is a VAULT read (ANTHROPIC_ACCOUNT__<name>) resolved through the
  // caller-supplied lookup; a selected account whose token cannot resolve
  // FAILS LOUD — launching on the machine's ambient login instead would be the
  // wrong-account bug this feature exists to kill. Injected as
  // ANTHROPIC_AUTH_TOKEN (+ CLAUDE_CODE_OAUTH_TOKEN): stored /login
  // credentials beat CLAUDE_CODE_OAUTH_TOKEN in the CLI, while
  // ANTHROPIC_AUTH_TOKEN beats stored credentials (verified live, 2.1.216) and
  // the claude-pty spawn never strips it — so providerLaunch stays false.
  const applyAccountPin = (): { env: Record<string, string>; providerLaunch: false; account?: string } => {
    const account = String(config.account ?? "").trim();
    if (!account) return { env, providerLaunch: false };
    // PAYMASTER: "auto" is resolved to a concrete account by the runner BEFORE
    // this pure builder runs. Seeing the literal here means a caller skipped
    // that step - fail loud instead of reading ANTHROPIC_ACCOUNT__auto.
    if (account === "auto") {
      throw new Error(
        `primary runtime ${descriptor.runtimeId}: account "auto" reached the env builder unresolved - ` +
          `the runner must resolve it via the Paymaster before building the spawn env.`
      );
    }
    const key = accountVaultKey(account);
    const token = secretLookup(key);
    if (!token) {
      throw new Error(
        `primary runtime ${descriptor.runtimeId} selects account "${account}" but ${key} did not resolve ` +
          `(vault locked or token absent) — log in again from the runtime config, or clear the account selector.`
      );
    }
    return { env: { ...env, ...accountAuthEnv(account, token) }, providerLaunch: false, account };
  };

  const provider = String(config.provider ?? "anthropic-plan");
  if (provider === "anthropic-plan") {
    return applyAccountPin();
  }

  const entry = providers.find((p) => p && p.id === provider);
  if (!entry) {
    throw new Error(
      `unknown provider "${provider}" for primary runtime ${descriptor.runtimeId}; ` +
        `expected one of ${providers.map((p) => p.id).join(", ")}.`
    );
  }
  // ONLY an explicit anthropic-plan kind is the Max-OAuth no-launch path (e.g.
  // the agent-sdk "anthropic" spelling). A null baseUrl on any OTHER kind is a
  // malformed entry and falls through to the requires-a-base-URL throw below —
  // never silently treated as the plan path.
  if (entry.kind === "anthropic-plan") {
    return applyAccountPin();
  }
  const spec = {
    baseUrl: entry.baseUrl ?? null,
    vaultKey: entry.vaultKey ?? null,
    dummyToken: entry.dummyToken ?? null
  };

  const baseUrlOverride = config.base_url !== undefined ? String(config.base_url).trim() : "";
  const baseUrl = baseUrlOverride || spec.baseUrl;
  if (!baseUrl) {
    throw new Error(`provider "${provider}" requires a base URL but none is configured.`);
  }
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.GARRISON_PROVIDER = provider;
  // Force the auth-token path (never ride an inherited ANTHROPIC_API_KEY).
  env.ANTHROPIC_API_KEY = "";

  let token = spec.dummyToken ?? "";
  if (spec.vaultKey) {
    const resolved = secretLookup(spec.vaultKey);
    if (!resolved) {
      throw new Error(
        `provider "${provider}" requires vault key ${spec.vaultKey}, which is missing or the vault is locked.`
      );
    }
    token = resolved;
  }
  if (token) {
    env.ANTHROPIC_AUTH_TOKEN = token;
  }

  return { env, providerLaunch: true };
}

/** A model-router target (subset of the routing.json target shape). */
export interface RouterTarget {
  id: string;
  type: "runtime-target" | "secondary";
  runtime: string;
  provider?: string;
  model?: string;
  /** RUNTIME-ACCOUNTS-V1: the fitting's selected Anthropic account (plan path). */
  account?: string;
  /** The runtime fitting this target was derived from (omitted for hand-seeded targets). */
  derivedFrom?: string;
}

/**
 * Derive model-router targets from the composed Runtime-Faculty fittings, so a
 * fitted runtime automatically becomes a selectable routing target without
 * hand-editing routing.json. claude-code engines become `runtime-target`s
 * (carrying their provider/model); other engines (agent-sdk/codex/gemini) become
 * `secondary` delegate targets. Ids are namespaced `fitted-<id>` so they never
 * collide with hand-seeded targets.
 */
export function deriveRuntimeTargets(runtimeEntries: RuntimeEntry[]): RouterTarget[] {
  return runtimeEntries.map((entry) => {
    const engine = engineOf(entry);
    const config = entry.config ?? {};
    // RUNTIME-ACCOUNTS-V1: carry the fitting's selected account onto the
    // derived target so the gateway's launch-env builders (stage-b /
    // agent-sdk) pin routed sessions to the same account as the fitting.
    // PAYMASTER: "auto" never lands on a derived target - the rotation
    // decision is made ONCE per operative spawn (in the runner) and delegate
    // sessions inherit that account through the launch env (sticky sessions,
    // D10). The literal "auto" would otherwise be read as a vault key name by
    // the fitting-side launch-env builders.
    const rawAccount = String(config.account ?? "").trim();
    const account = rawAccount === "auto" ? "" : rawAccount;
    if (engine === "claude-code") {
      return {
        id: `fitted-${entry.id}`,
        type: "runtime-target",
        runtime: "claude-code",
        provider: String(config.provider ?? "anthropic-plan"),
        model: String(config.model ?? "opus"),
        ...(account ? { account } : {}),
        derivedFrom: entry.id
      };
    }
    return {
      id: `fitted-${entry.id}`,
      type: "secondary",
      runtime: engine,
      ...(account ? { account } : {}),
      derivedFrom: entry.id
    };
  });
}

/**
 * Merge derived runtime targets into a routing config's `targets` array
 * (in place is avoided — returns a shallow-cloned config), de-duplicated by id so
 * an existing hand-seeded target always wins. Returns the config unchanged when
 * there are no derived targets.
 */
export function mergeRuntimeTargets<T extends { targets?: RouterTarget[] }>(
  config: T,
  derived: RouterTarget[]
): T {
  if (!derived.length) return config;
  const existing = Array.isArray(config.targets) ? config.targets : [];
  const existingIds = new Set(existing.map((t) => t.id));
  const additions = derived.filter((t) => !existingIds.has(t.id));
  if (!additions.length) return config;
  return { ...config, targets: [...existing, ...additions] };
}
