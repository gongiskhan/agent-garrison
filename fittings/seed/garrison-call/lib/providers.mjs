// providers.mjs — garrison-call named-provider table + generalized default-deny
// base-URL fence.
//
// garrison-call makes SINGLE-SHOT, STRUCTURED LLM calls only — no tool loop, no
// session, NEVER a primary. The fence here is the security boundary: a caller may
// only reach a base URL that is (a) an exact entry in the named-provider table, or
// (b) an explicit loopback (localhost / 127.0.0.1 / ::1) URL AND only for the
// ollama / openai wire shapes. Every other base URL is REJECTED loudly
// (default-deny) — there is NO wildcard / free-form / configurable entry, unlike
// the agent-sdk-runtime `llm-proxy` escape hatch this table deliberately drops.
//
// This mirrors the SEMANTICS of fittings/seed/agent-sdk-runtime/lib/providers.mjs
// (a fixed named table + strip-then-set env, a loud error on an unknown provider
// rather than a silent Max-plan fallback), but for RAW single-shot HTTP calls
// against three wire shapes rather than SDK sessions.
//
// Secrets are referenced by VAULT SECRET NAME only (the `authTokenEnv` field is an
// env-var NAME the vault materializes into) — a key value is NEVER inlined here,
// NEVER returned, and NEVER placed in an error message (errors name the env var,
// not its value).

// The three supported wire shapes.
//   anthropic — POST {baseUrl}/v1/messages           (Anthropic Messages API)
//   openai    — POST {baseUrl}/v1/chat/completions   (OpenAI-compatible Chat)
//   ollama    — POST {baseUrl}/api/generate          (Ollama native generate)
export const SHAPES = ["anthropic", "openai", "ollama"];

// Named-provider table. Each entry pins an EXACT baseUrl, the wire shapes it may
// serve, and how it authenticates. `authTokenEnv` is a VAULT SECRET NAME (env-var
// name), never a key. `needsKey:false` means the endpoint ignores auth (local
// Ollama) — a dummy token is sent where the shape requires an auth header.
export const PROVIDERS = {
  // Anthropic on the public API. A single-shot call here bills the API pool (this
  // fitting is never the primary/subscription session), so it needs an explicit key.
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    needsKey: true,
    authTokenEnv: "ANTHROPIC_API_KEY",
    shapes: ["anthropic"]
  },
  // Local Ollama (v0.14.0+ serves all three shapes: /api/generate native,
  // /v1/chat/completions OpenAI-compat, /v1/messages Anthropic-compat). Free, the
  // live test target. Auth is ignored; a dummy token covers the header shapes.
  "ollama-local": {
    baseUrl: "http://localhost:11434",
    needsKey: false,
    localhost: true,
    shapes: ["anthropic", "openai", "ollama"]
  },
  // Explicit configured remote entries (Anthropic-compatible). Present to show the
  // table is extensible by EXPLICIT entry only — each still pins one baseUrl + a
  // vault secret name; none is configurable/wildcard.
  deepseek: {
    baseUrl: "https://api.deepseek.com/anthropic",
    needsKey: true,
    authTokenEnv: "DEEPSEEK_API_KEY",
    shapes: ["anthropic"]
  },
  "zai-glm": {
    baseUrl: "https://api.z.ai/api/anthropic",
    needsKey: true,
    authTokenEnv: "ZAI_API_KEY",
    shapes: ["anthropic"]
  },
  // Explicit configured remote entry (OpenAI-compatible Chat Completions).
  openai: {
    baseUrl: "https://api.openai.com",
    needsKey: true,
    authTokenEnv: "OPENAI_API_KEY",
    shapes: ["openai"]
  }
};

// Broad model allowlist — any string a provider might front (Ollama tags,
// GLM/DeepSeek slots, OpenAI model ids), bounded in length + charset so a spec
// can never smuggle a URL / whitespace / control chars through the model field.
export const MODEL_ALLOWLIST = /^[\w./:+-]{1,128}$/;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
// Loopback base URLs are permitted ONLY for these shapes (a raw Anthropic-shape
// call to an unlisted loopback port is still denied — it must be a table entry).
const LOOPBACK_SHAPES = new Set(["ollama", "openai"]);

export class FenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "FenceError";
    this.code = "base-url-denied";
  }
}

export class UnknownProviderError extends Error {
  constructor(provider) {
    super(
      `unknown provider "${provider}" — not in the garrison-call allowlist (${Object.keys(PROVIDERS).join(", ")})`
    );
    this.name = "UnknownProviderError";
    this.code = "unknown-provider";
    this.provider = provider;
  }
}

export class ShapeError extends Error {
  constructor(shape) {
    super(`unknown call shape "${shape}" — must be one of ${SHAPES.join(", ")}`);
    this.name = "ShapeError";
    this.code = "unknown-shape";
    this.shape = shape;
  }
}

// A missing secret names the env var (a vault secret NAME), NEVER the value.
export class MissingKeyError extends Error {
  constructor(envName, provider) {
    super(
      `provider "${provider}" needs secret ${envName} but it is ABSENT from the environment — materialize it from the vault by name`
    );
    this.name = "MissingKeyError";
    this.code = "missing-key";
    this.envName = envName;
    this.provider = provider;
  }
}

function normalizeBaseUrl(u) {
  return String(u).replace(/\/+$/, "");
}

function isLoopback(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  // Loopback is only ever plain http on this box — a TLS remote can never be
  // mistaken for the local dev endpoint.
  return LOOPBACK_HOSTS.has(url.hostname) && url.protocol === "http:";
}

// The core fence for an EXPLICIT base URL (no provider, or a provider override).
// Returns the normalized URL when allowed; throws FenceError otherwise.
function fenceExplicitBaseUrl(baseUrl, shape) {
  const norm = normalizeBaseUrl(baseUrl);
  const listed = Object.values(PROVIDERS).some((p) => normalizeBaseUrl(p.baseUrl) === norm);
  if (listed) return norm;
  if (isLoopback(baseUrl)) {
    if (!LOOPBACK_SHAPES.has(shape)) {
      throw new FenceError(
        `loopback baseUrl "${baseUrl}" is permitted only for the ollama/openai shapes, not "${shape}" — REJECTED`
      );
    }
    return norm;
  }
  throw new FenceError(
    `base URL "${baseUrl}" is not in the garrison-call allowlist and is not loopback — REJECTED (default-deny). Add it as an explicit provider-table entry to permit it.`
  );
}

// Resolve a spec to a concrete target { baseUrl, needsKey, authTokenEnv, provider },
// applying the default-deny fence. Throws ShapeError / UnknownProviderError /
// FenceError on any unlisted target. Pure — no env reads, no network, no secrets.
export function resolveTarget(spec = {}) {
  const shape = spec.shape;
  if (!SHAPES.includes(shape)) throw new ShapeError(shape);

  if (spec.provider != null && spec.provider !== "") {
    const p = PROVIDERS[spec.provider];
    if (!p) throw new UnknownProviderError(spec.provider);
    if (p.shapes && !p.shapes.includes(shape)) {
      throw new FenceError(
        `provider "${spec.provider}" does not serve the "${shape}" shape (serves: ${p.shapes.join(", ")}) — REJECTED`
      );
    }
    let baseUrl = normalizeBaseUrl(p.baseUrl);
    // An explicit baseUrl override is honored ONLY if it still passes the fence.
    // CRITICAL (S2b review finding): the spec is LLM-authored (untrusted under
    // prompt injection). If the override diverges from the provider's PINNED
    // host, we must NOT ship the provider's real credential to it — that is a
    // key-exfil vector (send openai's key to http://127.0.0.1:<attacker>). An
    // override to a different host is treated as an unauthenticated dev endpoint:
    // the provider's authTokenEnv/needsKey are dropped. Only an override that
    // resolves back to the provider's own URL keeps its credential.
    if (spec.baseUrl && normalizeBaseUrl(spec.baseUrl) !== baseUrl) {
      const overridden = fenceExplicitBaseUrl(spec.baseUrl, shape);
      if (overridden !== baseUrl) {
        return { baseUrl: overridden, needsKey: false, authTokenEnv: null, provider: null };
      }
      baseUrl = overridden;
    }
    return { baseUrl, needsKey: !!p.needsKey, authTokenEnv: p.authTokenEnv || null, provider: spec.provider };
  }

  if (spec.baseUrl != null && spec.baseUrl !== "") {
    const baseUrl = fenceExplicitBaseUrl(spec.baseUrl, shape);
    // If the explicit URL matches a named entry, inherit its auth requirement;
    // otherwise it is a loopback dev endpoint that needs no key.
    const match = Object.entries(PROVIDERS).find(([, p]) => normalizeBaseUrl(p.baseUrl) === baseUrl);
    if (match) {
      const [name, p] = match;
      return { baseUrl, needsKey: !!p.needsKey, authTokenEnv: p.authTokenEnv || null, provider: name };
    }
    return { baseUrl, needsKey: false, authTokenEnv: null, provider: null };
  }

  throw new FenceError("no target — the spec must name a listed `provider` or an allowed `baseUrl`");
}

// Resolve the auth token from the environment BY NAME. Returns the value for use
// as a request header only; the value is never logged or returned in an error.
// A dummy token is returned for keyless (loopback) endpoints so the Anthropic /
// OpenAI header shapes stay well-formed (Ollama ignores it).
export function resolveAuthToken(target, env = process.env) {
  if (!target.needsKey) return "ollama"; // dummy; loopback endpoints ignore auth
  const value = target.authTokenEnv ? env[target.authTokenEnv] : undefined;
  if (!value) throw new MissingKeyError(target.authTokenEnv, target.provider);
  return value;
}

export function assertModelAllowed(model) {
  if (typeof model !== "string" || !MODEL_ALLOWLIST.test(model)) {
    throw new Error(`model "${model}" is not an allowed model string (must match ${MODEL_ALLOWLIST})`);
  }
  return model;
}
