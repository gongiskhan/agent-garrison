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
 * Anthropic-compatible provider registry for the PRIMARY (orchestrator) runtime.
 * Mirrors the model-router's PROVIDERS (fittings/seed/model-router/lib/stage-b.mjs)
 * — the router owns per-turn provider switching; this owns the launch-time env for
 * the primary. anthropic-plan is the default (Max OAuth, no base URL).
 */
export const PRIMARY_PROVIDERS: Record<
  string,
  { baseUrl: string | null; vaultKey: string | null; dummyToken: string | null }
> = {
  "anthropic-plan": { baseUrl: null, vaultKey: null, dummyToken: null },
  "ollama-local": { baseUrl: "http://localhost:11434", vaultKey: null, dummyToken: "ollama" },
  deepseek: { baseUrl: "https://api.deepseek.com/anthropic", vaultKey: "DEEPSEEK_API_KEY", dummyToken: null },
  "zai-glm": { baseUrl: "https://api.z.ai/api/anthropic", vaultKey: "ZAI_API_KEY", dummyToken: null }
};

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
 */
export function buildPrimaryRuntimeEnv(
  descriptor: PrimaryRuntimeDescriptor,
  secretLookup: (vaultKey: string) => string | undefined
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

  const provider = String(config.provider ?? "anthropic-plan");
  if (provider === "anthropic-plan") {
    return { env, providerLaunch: false };
  }

  const spec = PRIMARY_PROVIDERS[provider];
  if (!spec) {
    throw new Error(
      `unknown provider "${provider}" for primary runtime ${descriptor.runtimeId}; ` +
        `expected one of ${Object.keys(PRIMARY_PROVIDERS).join(", ")}.`
    );
  }

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
    if (engine === "claude-code") {
      return {
        id: `fitted-${entry.id}`,
        type: "runtime-target",
        runtime: "claude-code",
        provider: String(config.provider ?? "anthropic-plan"),
        model: String(config.model ?? "opus"),
        derivedFrom: entry.id
      };
    }
    return {
      id: `fitted-${entry.id}`,
      type: "secondary",
      runtime: engine,
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
