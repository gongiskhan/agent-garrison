// providers.mjs — Agent-SDK provider table + capability records.
//
// The Agent SDK runtime is first-class routable (D29): it reaches the Anthropic
// endpoint on the Max subscription as well as third-party Anthropic-compatible
// endpoints (Ollama / Z.ai / DeepSeek / MiniMax / LLM proxy). Third-party
// providers authenticate from
// the Vault; the Anthropic subscription path uses the stored OAuth credentials
// (no key, no base URL override). Each provider carries an `authMode`
// (subscription / api-key / local) surfaced in the composer + Quarters view.
// Capability record per target generalises `effort: unsupported`: it records which
// content-block features the endpoint actually serves, so the orchestrator never
// routes an unsupported block type (e.g. MCP / vision) at a target that cannot
// serve it.

// A capability record: which content-block types the endpoint serves.
const FULL_CAPS = { text: true, toolUse: true, image: true, document: true, webSearch: true, mcp: true };
const TEXT_TOOLS_ONLY = { text: true, toolUse: true, image: false, document: false, webSearch: false, mcp: false };
const TEXT_TOOLS_MCP = { text: true, toolUse: true, image: false, document: false, webSearch: false, mcp: true };

export const SDK_PROVIDERS = {
  // The Anthropic endpoint on the Max subscription (D29). No base URL override and
  // no key — the SDK uses the stored OAuth credentials and bills the plan, exactly
  // like the main operative. A first-class routing destination.
  anthropic: {
    baseUrl: null,
    anthropic: true,
    needsKey: false,
    authMode: "subscription",
    effort: true,
    capabilities: FULL_CAPS
  },
  // Local Ollama native Anthropic-compatible endpoint (v0.14.0+). Free, the live
  // test target. Auth token is a dummy ("ollama"); ANTHROPIC_API_KEY must be "".
  "ollama-local": {
    baseUrl: "http://localhost:11434",
    needsKey: false,
    dummyToken: "ollama",
    authTokenEnv: "ANTHROPIC_AUTH_TOKEN",
    authMode: "local",
    effort: false,
    capabilities: TEXT_TOOLS_MCP
  },
  // Z.ai / GLM native Anthropic endpoint; Claude model slots map server-side to GLM.
  "zai-glm": {
    baseUrl: "https://api.z.ai/api/anthropic",
    needsKey: true,
    vaultKey: "ZAI_API_KEY",
    authTokenEnv: "ANTHROPIC_AUTH_TOKEN",
    authMode: "api-key",
    effort: false,
    capabilities: TEXT_TOOLS_MCP
  },
  // DeepSeek native Anthropic endpoint. Capability record MUST flag text + tool
  // use ONLY — it drops image / document / web-search / MCP blocks.
  deepseek: {
    baseUrl: "https://api.deepseek.com/anthropic",
    needsKey: true,
    vaultKey: "DEEPSEEK_API_KEY",
    authTokenEnv: "ANTHROPIC_AUTH_TOKEN",
    authMode: "api-key",
    effort: false,
    capabilities: TEXT_TOOLS_ONLY
  },
  // MiniMax native Anthropic endpoint. Pre-existing ANTHROPIC_* env take
  // precedence, so buildSdkEnv clears them first.
  minimax: {
    baseUrl: "https://api.minimax.io/anthropic",
    needsKey: true,
    vaultKey: "MINIMAX_API_KEY",
    authTokenEnv: "ANTHROPIC_AUTH_TOKEN",
    authMode: "api-key",
    effort: false,
    capabilities: TEXT_TOOLS_ONLY
  },
  // The general escape hatch: a configurable Anthropic-compatible proxy (e.g.
  // LiteLLM) fronting any model (OpenAI / Gemini / Qwen on vLLM / new drops). The
  // base URL is per-target; the model is a free-text string. New-model onboarding
  // (test models the day they ship) points this at the endpoint with zero code
  // change. Capability record defaults to text+tools; override per-target.
  "llm-proxy": {
    baseUrl: null,
    configurable: true,
    needsKey: true,
    vaultKey: "LLM_PROXY_API_KEY",
    authTokenEnv: "ANTHROPIC_AUTH_TOKEN",
    authMode: "api-key",
    effort: false,
    capabilities: TEXT_TOOLS_ONLY
  }
};

export const FULL_CAPABILITIES = FULL_CAPS;

// True for providers on the Anthropic subscription path (no base-URL override).
// The `coding` harness mode — which loads the user's ~/.claude settings, env
// block included — is only honored for these providers; anywhere else a user
// env could silently redirect the endpoint (the #217 trap).
export function isAnthropicProvider(provider) {
  return SDK_PROVIDERS[provider]?.anthropic === true;
}

export class MissingProviderKeyError extends Error {
  constructor(provider, vaultKey, vaultLocked) {
    super(
      vaultLocked
        ? `agent-sdk provider "${provider}" needs ${vaultKey} but the vault is LOCKED — unlock it`
        : `agent-sdk provider "${provider}" needs ${vaultKey} but it is ABSENT from the materialized vault`
    );
    this.name = "MissingProviderKeyError";
    this.code = "missing-provider-key";
    this.provider = provider;
    this.vaultKey = vaultKey;
    this.vaultLocked = !!vaultLocked;
  }
}

export class CapabilityError extends Error {
  constructor(provider, block) {
    super(`agent-sdk provider "${provider}" does not serve content-block type "${block}" — refusing to route`);
    this.name = "CapabilityError";
    this.code = "capability-unsupported";
    this.provider = provider;
    this.block = block;
  }
}

// The resolved base URL for a target (null for the Anthropic subscription path;
// a per-target override for the configurable proxy). Cheap, no secrets.
export function resolveProviderBaseUrl(target = {}) {
  const spec = SDK_PROVIDERS[target.provider];
  if (!spec) throw new Error(`unknown agent-sdk provider "${target.provider}"`);
  const baseUrl = spec.configurable ? target.baseUrl ?? null : spec.baseUrl;
  if (spec.configurable && !baseUrl) {
    throw new Error(`agent-sdk provider "${target.provider}" requires an explicit target.baseUrl`);
  }
  return baseUrl;
}

// Build the env passed to the SDK's options.env. Mirrors stage-b's
// strip-then-set: clear inherited Anthropic vars first (MiniMax precedence trap),
// then set the endpoint base URL + auth token. Pure + testable; argv/env are
// asserted without spawning. opts.secrets is the materialized vault or null.
export function buildSdkEnv(target = {}, opts = {}) {
  const spec = SDK_PROVIDERS[target.provider];
  if (!spec) throw new Error(`unknown agent-sdk provider "${target.provider}"`);
  const baseUrl = resolveProviderBaseUrl(target);
  const secrets = opts.secrets ?? null;

  const baseEnv = opts.baseEnv ?? {};
  const env = { ...baseEnv };
  // Clear any inherited Anthropic env (a stray third-party base URL / key must
  // never leak; MiniMax & others take precedence otherwise).
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // RUNTIME-ACCOUNTS-V1: an inherited account token must never leak into a
  // target with a different — or no — account.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.GARRISON_ACCOUNT;

  // Anthropic on the Max subscription: no base URL override, no key — the SDK
  // falls back to the stored OAuth credentials (D29), billed to the plan.
  // Force the key EMPTY (not merely deleted): the delete above only cleans
  // opts.baseEnv, and the SDK inherits the PROCESS env underneath — a stray
  // ANTHROPIC_API_KEY there would silently bill the API pool instead.
  //
  // RUNTIME-ACCOUNTS-V1: target.account pins the session to a named account —
  // the vault secret ANTHROPIC_ACCOUNT__<name> (mirror of
  // src/lib/account-env.ts) injected as ANTHROPIC_AUTH_TOKEN, which the
  // spawned Claude Code binary honors ABOVE its stored /login credentials
  // (verified live, 2.1.216). Without an explicit account the launching
  // session's pin (baseEnv.GARRISON_ACCOUNT + token) is inherited, so a
  // delegate turn runs under the same account as the session that asked.
  if (spec.anthropic) {
    env.ANTHROPIC_API_KEY = "";
    const account = String(target.account ?? "").trim();
    if (account) {
      const accountKey = `ANTHROPIC_ACCOUNT__${account}`;
      const vaultLocked = secrets === null;
      const token = vaultLocked ? undefined : secrets[accountKey];
      if (!token) throw new MissingProviderKeyError(`${target.provider} (account "${account}")`, accountKey, vaultLocked);
      env.ANTHROPIC_AUTH_TOKEN = token;
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
      env.GARRISON_ACCOUNT = account;
      return { env, baseUrl: null, vaultKey: accountKey };
    }
    if (baseEnv.GARRISON_ACCOUNT && baseEnv.ANTHROPIC_AUTH_TOKEN) {
      env.ANTHROPIC_AUTH_TOKEN = baseEnv.ANTHROPIC_AUTH_TOKEN;
      env.CLAUDE_CODE_OAUTH_TOKEN = baseEnv.CLAUDE_CODE_OAUTH_TOKEN ?? baseEnv.ANTHROPIC_AUTH_TOKEN;
      env.GARRISON_ACCOUNT = baseEnv.GARRISON_ACCOUNT;
    }
    return { env, baseUrl: null, vaultKey: null };
  }

  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_API_KEY = ""; // force the SDK onto AUTH_TOKEN, never an inherited key

  if (spec.needsKey) {
    const vaultLocked = secrets === null;
    const key = vaultLocked ? undefined : secrets[spec.vaultKey];
    if (!key) throw new MissingProviderKeyError(target.provider, spec.vaultKey, vaultLocked);
    env[spec.authTokenEnv] = key;
  } else {
    env[spec.authTokenEnv] = spec.dummyToken || "local"; // Ollama ignores auth
  }

  return { env, baseUrl, vaultKey: spec.needsKey ? spec.vaultKey : null };
}

// The capability record for a target, including effort support. A per-target
// `capabilities` override (for llm-proxy / new models) wins over the provider
// default.
export function capabilityRecord(target = {}) {
  const spec = SDK_PROVIDERS[target.provider];
  const base = target.capabilities ?? spec?.capabilities ?? TEXT_TOOLS_ONLY;
  return {
    provider: target.provider ?? null,
    text: !!base.text,
    toolUse: !!base.toolUse,
    image: !!base.image,
    document: !!base.document,
    webSearch: !!base.webSearch,
    mcp: !!base.mcp,
    effort: spec?.effort ? "supported" : "unsupported"
  };
}

const BLOCK_TO_CAP = {
  image: "image",
  document: "document",
  "web-search": "webSearch",
  webSearch: "webSearch",
  mcp: "mcp",
  tool_use: "toolUse",
  toolUse: "toolUse",
  text: "text"
};

// Refuse to route if the target cannot serve a required content-block type. The
// orchestrator calls this before dispatching (e.g. an MCP role at deepseek).
export function assertSupportsBlocks(target, requiredBlocks = []) {
  const rec = capabilityRecord(target);
  for (const b of requiredBlocks) {
    const cap = BLOCK_TO_CAP[b] ?? b;
    if (!rec[cap]) throw new CapabilityError(target.provider, b);
  }
  return rec;
}

// Orchestrator-side route gate. Only agent-sdk runtime-targets carry a capability
// record here, so non-agent-sdk targets pass through (their capabilities are the
// other runtime's concern). Throws CapabilityError on an unsupported block so the
// orchestrator never routes an MCP-dependent / vision task at a target that
// cannot serve it (e.g. MCP @ deepseek) — the caller then redirects to a capable
// target.
export function assertRouteCapability(target, requiredBlocks = []) {
  if (!target || target.runtime !== "agent-sdk") return null;
  return assertSupportsBlocks(target, requiredBlocks);
}

// LiteLLM supply-chain guard (TeamPCP PyPI compromise, March 2026): forbid
// 1.82.7 / 1.82.8 (exfiltrated credentials); pin <= 1.82.6. The install allowlist
// encodes this; only exercised when the llm-proxy is a LiteLLM install.
export const LITELLM_FORBIDDEN = ["1.82.7", "1.82.8"];
export const LITELLM_MAX = "1.82.6";

function cmpSemver(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

export function assertLitellmVersionAllowed(version) {
  if (LITELLM_FORBIDDEN.includes(version)) {
    throw new Error(
      `LiteLLM ${version} is FORBIDDEN (TeamPCP PyPI supply-chain compromise, March 2026, exfiltrated credentials). Pin <= ${LITELLM_MAX}.`
    );
  }
  if (cmpSemver(version, LITELLM_MAX) > 0) {
    throw new Error(`LiteLLM ${version} exceeds the pinned max ${LITELLM_MAX} — pin <= ${LITELLM_MAX}.`);
  }
  return true;
}

// The authMode a target resolves to (subscription / api-key / local) — the label
// the composer + Quarters view show. A per-target authMode wins; else the
// provider's default; else "subscription" (the Anthropic Max path).
export function authModeFor(target = {}) {
  if (target.authMode) return target.authMode;
  const spec = SDK_PROVIDERS[target.provider];
  return spec?.authMode || "subscription";
}
