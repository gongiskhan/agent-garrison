// providers.mjs — Agent-SDK provider table + capability records (BRIEF
// §"Providers"). All providers REQUIRE a non-Anthropic base URL (THE FENCE
// enforces it); all are authenticated from the Vault. Self-contained (mirrors the
// Orchestrator routing-target base URLs; the capability records and SDK env wiring are
// SDK-specific). Capability record per target generalises `effort: unsupported`:
// it records which content-block features the endpoint actually serves, so the
// orchestrator never routes an unsupported block type (e.g. MCP / vision) at a
// target that cannot serve it.

import { isAnthropicBaseUrl } from "./fence.mjs";

// A capability record: which content-block types the endpoint serves.
const FULL_CAPS = { text: true, toolUse: true, image: true, document: true, webSearch: true, mcp: true };
const TEXT_TOOLS_ONLY = { text: true, toolUse: true, image: false, document: false, webSearch: false, mcp: false };
const TEXT_TOOLS_MCP = { text: true, toolUse: true, image: false, document: false, webSearch: false, mcp: true };

export const SDK_PROVIDERS = {
  // Local Ollama native Anthropic-compatible endpoint (v0.14.0+). Free, the live
  // test target. Auth token is a dummy ("ollama"); ANTHROPIC_API_KEY must be "".
  "ollama-local": {
    baseUrl: "http://localhost:11434",
    needsKey: false,
    dummyToken: "ollama",
    authTokenEnv: "ANTHROPIC_AUTH_TOKEN",
    effort: false,
    capabilities: TEXT_TOOLS_MCP
  },
  // Z.ai / GLM native Anthropic endpoint; Claude model slots map server-side to GLM.
  "zai-glm": {
    baseUrl: "https://api.z.ai/api/anthropic",
    needsKey: true,
    vaultKey: "ZAI_API_KEY",
    authTokenEnv: "ANTHROPIC_AUTH_TOKEN",
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
    effort: false,
    capabilities: TEXT_TOOLS_ONLY
  }
};

export const FULL_CAPABILITIES = FULL_CAPS;

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

// The resolved base URL for a target (per-target override for the configurable
// proxy). Cheap, no secrets — THE FENCE runs on this before any key resolution.
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
// then set the non-Anthropic base URL + auth token. Pure + testable; argv/env are
// asserted without spawning. opts.secrets is the materialized vault or null.
export function buildSdkEnv(target = {}, opts = {}) {
  const spec = SDK_PROVIDERS[target.provider];
  if (!spec) throw new Error(`unknown agent-sdk provider "${target.provider}"`);
  const baseUrl = resolveProviderBaseUrl(target);
  const secrets = opts.secrets ?? null;

  const env = { ...(opts.baseEnv ?? {}) };
  // Clear any inherited Anthropic env (MiniMax & others take precedence otherwise).
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;

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

// Sanity helper used by the bridge self-test: every provider's static base URL
// (where not configurable) must be non-Anthropic.
export function staticBaseUrlsAreNonAnthropic() {
  return Object.entries(SDK_PROVIDERS)
    .filter(([, s]) => !s.configurable)
    .every(([, s]) => !isAnthropicBaseUrl(s.baseUrl));
}
