// providers.mjs - OpenAI-compatible provider table + capability records.
//
// The OpenAI Agents runtime speaks the OpenAI wire format (/v1/chat/completions),
// complementary to the agent-sdk runtime's Anthropic-compatible contract. It
// reaches OpenAI cloud, a LOCAL Ollama endpoint (http://localhost:11434/v1), and
// any OpenAI-compatible base URL (vLLM / Groq / Together / LM Studio / a LiteLLM
// proxy in OpenAI mode). The endpoint is passed DIRECTLY to the OpenAI client
// (`new OpenAI({ baseURL, apiKey })`) - a per-call client, never a process-global
// (avoids the setDefaultOpenAIClient global-state trap so concurrent delegations
// may target different endpoints).
//
// The API key is resolved BY NAME from the Vault (OPENAI_API_KEY, declared in the
// manifest's secret_scope): it is read server-side from the materialized env and
// passed to the client - it never enters argv and never reaches a browser. Each
// provider carries a capability record so the orchestrator never routes a block
// type the endpoint cannot serve (e.g. vision at a text-only local model).

// Capability records: which content-block types THIS runtime wires at the endpoint.
// This runtime wires function tools (toolUse) + text over chat_completions; hosted
// web-search / MCP / document blocks are NOT wired here, so they read false even at
// OpenAI cloud (honest about what the runtime serves, not what the API could).
const TEXT_TOOLS = { text: true, toolUse: true, image: false, document: false, webSearch: false, mcp: false };
const VISION_TOOLS = { text: true, toolUse: true, image: true, document: false, webSearch: false, mcp: false };

// The canonical Vault key name for OpenAI-compatible endpoints. Declared in the
// manifest's secret_scope; the runner materializes it into the server-side env.
export const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";

/** The ChatGPT subscription endpoint: the Codex backend, Responses API only. */
export const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";

// The canonical env var naming the TRUSTED base URL of a configurable provider.
// A provider entry may override it with `baseUrlEnv` so a second self-hosted
// endpoint gets its own key/URL pair instead of contending for this one: two
// endpoints sharing OPENAI_API_KEY + OPENAI_BASE_URL cannot both be configured
// in the same composition, and whichever one lost would silently egress the
// other's key (or, per the fence below, silently drop to keyless).
export const DEFAULT_BASE_URL_ENV = "OPENAI_BASE_URL";

/** The env var holding the trusted base URL for a provider entry. */
export function baseUrlEnvFor(spec) {
  return spec?.baseUrlEnv || DEFAULT_BASE_URL_ENV;
}

/** A locked vault reads as `null` secrets, distinct from an unlocked-but-empty `{}`. */
function vaultLockedFor(secrets) {
  return secrets === null || secrets === undefined;
}

export const OPENAI_PROVIDERS = {
  // OpenAI cloud. Base URL is the SDK default (https://api.openai.com/v1) - left
  // null so the client uses its own default. Needs OPENAI_API_KEY from the Vault.
  openai: {
    baseUrl: null,
    needsKey: true,
    apiKeyEnv: "OPENAI_API_KEY",
    authMode: "api-key",
    effort: false,
    capabilities: VISION_TOOLS
  },
  // Local Ollama, OpenAI-compatible endpoint (/v1). Free, the live test target.
  // No key - the OpenAI client requires a non-empty apiKey string, so a dummy is
  // sent; Ollama ignores it.
  "ollama-local": {
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    dummyToken: "ollama",
    authMode: "local",
    effort: false,
    capabilities: TEXT_TOOLS
  },
  // The escape hatch: any OpenAI-compatible endpoint (vLLM / Groq / Together / LM
  // Studio / LiteLLM in OpenAI mode / a new provider the day it ships). The base
  // URL is per-target (or OPENAI_BASE_URL from the server-side env); the model is
  // free-text. Needs OPENAI_API_KEY unless the target marks it keyless (a local,
  // unauthenticated endpoint). Capability record defaults to text+tools; override
  // per-target for a vision/other-capable endpoint.
  "openai-compat": {
    baseUrl: null,
    configurable: true,
    needsKey: true,
    apiKeyEnv: "OPENAI_API_KEY",
    authMode: "api-key",
    effort: false,
    capabilities: TEXT_TOOLS
  },
  // The ChatGPT SUBSCRIPTION, via the Codex backend. This is the one provider
  // here that is not an OpenAI-compatible /v1 endpoint and not key-authenticated:
  // it is the Responses API at chatgpt.com/backend-api/codex, carrying the OAuth
  // credential `codex login` mints. It exists so an operative can run on the plan
  // the user already pays for instead of metered platform tokens.
  //
  // `needsKey: false` is not "unauthenticated" - the bearer is injected per request
  // by chatgpt-transport's fetch from the account's auth.json, which is also what
  // refreshes and re-persists the rotating token. resolveEndpoint therefore hands
  // the client a dummy string (the OpenAI constructor demands a non-empty apiKey)
  // that never reaches the wire.
  //
  // `wireApi: "responses"` selects OpenAIResponsesModel over the chat-completions
  // model every other provider here uses: this backend serves ONLY /responses.
  //
  // Honest scope: this is not a documented OpenAI integration. The credential is
  // sanctioned for Codex clients, and the backend routes the gpt-5.6 family only
  // for a recognised `originator`, so this rides the same plan limits as the Codex
  // CLI and can break when that private contract moves. Vision is real (the
  // catalog reports text+image on the gpt-5.6 family); hosted web-search and MCP
  // are not wired by this runtime, so they stay false as everywhere else here.
  "chatgpt-subscription": {
    baseUrl: CHATGPT_BASE_URL,
    needsKey: false,
    dummyToken: "chatgpt-subscription",
    authMode: "subscription",
    wireApi: "responses",
    effort: true,
    capabilities: VISION_TOOLS
  },
  // A self-hosted GLM deployment behind an OpenAI-compatible server (vLLM /
  // SGLang / a uvicorn wrapper). Mechanically identical to `openai-compat` - the
  // difference is the env PAIR it reads: GLM_BASE_URL + GLM_API_KEY. That
  // separation is the whole point of the entry: `openai-compat` is already
  // spoken for by OPENAI_API_KEY, so a composition that wants BOTH a real OpenAI
  // key and a self-hosted endpoint needs two independent slots. The base URL is
  // per-composition (the runtime fitting's `baseUrl` config, projected into
  // GLM_BASE_URL) because a self-hosted host:port is not a stable constant worth
  // pinning in code - the deployment moves and the key follows it.
  //
  // Capabilities: text + function tools only. GLM served over plain
  // chat_completions carries no hosted web-search, no MCP, no document blocks;
  // image support depends on the served checkpoint, so it is NOT claimed here
  // (set `capabilities` per-target for a vision-capable deployment).
  glm: {
    baseUrl: null,
    configurable: true,
    baseUrlEnv: "GLM_BASE_URL",
    needsKey: true,
    apiKeyEnv: "GLM_API_KEY",
    authMode: "api-key",
    effort: false,
    capabilities: TEXT_TOOLS
  }
};

export class MissingProviderKeyError extends Error {
  constructor(provider, apiKeyEnv, vaultLocked) {
    super(
      vaultLocked
        ? `openai-agents provider "${provider}" needs ${apiKeyEnv} but the vault is LOCKED - unlock it`
        : `openai-agents provider "${provider}" needs ${apiKeyEnv} but it is ABSENT from the materialized vault`
    );
    this.name = "MissingProviderKeyError";
    this.code = "missing-provider-key";
    this.provider = provider;
    this.apiKeyEnv = apiKeyEnv;
    this.vaultLocked = !!vaultLocked;
  }
}

export class CapabilityError extends Error {
  constructor(provider, block) {
    super(`openai-agents provider "${provider}" does not serve content-block type "${block}" - refusing to route`);
    this.name = "CapabilityError";
    this.code = "capability-unsupported";
    this.provider = provider;
    this.block = block;
  }
}

// A base URL must be an http(s) URL - a light fence so a typo / injected value
// can't send the client somewhere unexpected. (Full default-deny base-URL fencing
// is the garrison-call fitting's job; here we only reject a non-http(s) URL.)
export function assertValidBaseUrl(url, provider) {
  if (url == null) return null; // the provider's own default (OpenAI cloud)
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`openai-agents provider "${provider}" base URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`openai-agents provider "${provider}" base URL must be http(s), got ${parsed.protocol}`);
  }
  return url;
}

// The resolved base URL for a target (null → the OpenAI client default for the
// cloud provider; a per-target / OPENAI_BASE_URL override for the configurable
// provider). Cheap, no secrets.
export function resolveBaseUrl(target = {}, opts = {}) {
  const spec = OPENAI_PROVIDERS[target.provider];
  if (!spec) throw new Error(`unknown openai-agents provider "${target.provider}"`);
  const env = opts.env ?? {};
  const secrets = opts.secrets ?? null;
  let baseUrl;
  if (spec.configurable) {
    const urlEnv = baseUrlEnvFor(spec);
    // env first (the runner's projection of the fitting config), then the
    // materialized Vault — so naming the endpoint as a plain vault value works too.
    // Keep this fallback order identical to the fence in resolveEndpoint, or a
    // vault-only setup resolves a URL here and then silently loses its key there.
    baseUrl = target.baseUrl ?? env[urlEnv] ?? (secrets ? secrets[urlEnv] : undefined) ?? null;
    if (!baseUrl) {
      throw new Error(
        `openai-agents provider "${target.provider}" requires an explicit target.baseUrl (or ${urlEnv} in the env / vault)`
      );
    }
  } else {
    baseUrl = spec.baseUrl;
  }
  return assertValidBaseUrl(baseUrl, target.provider);
}

// Canonical form for base-URL COMPARISON only (never used to build the request
// URL): lowercase scheme+host via URL parsing (default ports collapse), trailing
// slashes trimmed - so "https://Host/v1/" and "https://host:443/v1" compare equal.
function normalizeBaseUrl(u) {
  try {
    const url = new URL(String(u));
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(u ?? "").trim().replace(/\/+$/, "").toLowerCase();
  }
}

// Resolve the endpoint {baseUrl, apiKey, apiKeyEnv} for a target. The key is
// resolved BY NAME (OPENAI_API_KEY) from the materialized Vault secrets (or, for
// the primary path, the same server-side env). A needed-but-missing key fails
// loudly, distinguishing a LOCKED vault (secrets === null) from an ABSENT key.
// `target.keyless` lets the configurable provider name a local, unauthenticated
// endpoint (no key required).
export function resolveEndpoint(target = {}, opts = {}) {
  const spec = OPENAI_PROVIDERS[target.provider];
  if (!spec) throw new Error(`unknown openai-agents provider "${target.provider}"`);
  const baseUrl = resolveBaseUrl(target, opts);
  const secrets = opts.secrets ?? null;
  const env = opts.env ?? {};

  const needsKey = spec.needsKey && !target.keyless;
  if (!needsKey) {
    return { baseUrl, apiKey: spec.dummyToken || "unused", apiKeyEnv: null };
  }

  // Defense-in-depth key-egress fence (codex checkpoint finding): for a
  // CONFIGURABLE provider (openai-compat / glm), the vault key must only be
  // attached to a TRUSTED base URL — the server-side env (the provider's own
  // baseUrlEnv), never an explicit target.baseUrl that diverges from it (which
  // could be attacker/spec-authored). The bridge already strips an untrusted
  // spec.baseUrl for keyed calls (S2a); this closes the direct-call path too: a
  // keyed configurable target whose baseUrl is NOT the trusted env value drops to
  // keyless rather than shipping the key to that host.
  //
  // Consequence worth stating plainly, because it is the failure mode a new
  // self-hosted endpoint hits first: with the trusted env var UNSET, every keyed
  // configurable target is keyless and the endpoint answers 401. That is why the
  // runner projects the fitting's `baseUrl` config into this env var
  // (provider_mechanism.base_url_env) — the user set it in the UI, so it is a
  // trusted source, unlike a routing target an LLM may have authored.
  if (spec.configurable) {
    const urlEnv = baseUrlEnvFor(spec);
    // Both sources are user-set and server-side, so both are trusted: the env
    // (projected from the runtime fitting's own `baseUrl` config by the runner) and
    // the materialized Vault. Only a routing target — which an LLM may have
    // authored — is untrusted, and that is exactly what this compares against.
    const declared = env[urlEnv] ?? (vaultLockedFor(secrets) ? undefined : secrets[urlEnv]);
    const trustedBase = declared ? normalizeBaseUrl(declared) : null;
    if (!trustedBase || normalizeBaseUrl(baseUrl) !== trustedBase) {
      return { baseUrl, apiKey: spec.dummyToken || "unused", apiKeyEnv: null };
    }
  }

  const apiKeyEnv = target.apiKeyEnv || spec.apiKeyEnv || DEFAULT_API_KEY_ENV;
  const vaultLocked = secrets === null;
  // The key may arrive via the materialized Vault secrets (secondary/bridge path)
  // or the server-side env (primary path); both are server-side only.
  const key = (vaultLocked ? undefined : secrets[apiKeyEnv]) ?? env[apiKeyEnv];
  if (!key) throw new MissingProviderKeyError(target.provider, apiKeyEnv, vaultLocked && !env[apiKeyEnv]);
  return { baseUrl, apiKey: key, apiKeyEnv };
}

// The capability record for a target. A per-target `capabilities` override (for
// openai-compat / new models) wins over the provider default.
export function capabilityRecord(target = {}) {
  const spec = OPENAI_PROVIDERS[target.provider];
  const base = target.capabilities ?? spec?.capabilities ?? TEXT_TOOLS;
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

// Refuse to route if the target cannot serve a required content-block type.
export function assertSupportsBlocks(target, requiredBlocks = []) {
  const rec = capabilityRecord(target);
  for (const b of requiredBlocks) {
    const cap = BLOCK_TO_CAP[b] ?? b;
    if (!rec[cap]) throw new CapabilityError(target.provider, b);
  }
  return rec;
}

// Orchestrator-side route gate. Only openai-agents runtime-targets carry a
// capability record here, so non-openai-agents targets pass through.
export function assertRouteCapability(target, requiredBlocks = []) {
  if (!target || target.runtime !== "openai-agents") return null;
  return assertSupportsBlocks(target, requiredBlocks);
}

// Which HTTP contract a target's provider speaks. Providers default to
// chat-completions (every OpenAI-compatible endpoint); only the ChatGPT
// subscription declares `responses`, because the Codex backend serves nothing
// else. Read by the client builder to pick the SDK model class.
export function wireApiFor(target = {}) {
  if (target.wireApi) return target.wireApi;
  return OPENAI_PROVIDERS[target.provider]?.wireApi || "chat";
}

// The authMode a target resolves to (api-key / local) - the label the composer +
// Quarters view show. A per-target authMode wins; else the provider's default;
// else "api-key".
export function authModeFor(target = {}) {
  if (target.authMode) return target.authMode;
  const spec = OPENAI_PROVIDERS[target.provider];
  return spec?.authMode || "api-key";
}
