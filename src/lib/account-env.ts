// account-env.ts — RUNTIME-ACCOUNTS: the pure vocabulary of runtime accounts.
// No I/O here — imported by the pure spawn-env builders (runtime-selection.ts)
// and the registry (accounts.ts), so it must stay side-effect free.
//
// An "account" is a named credential (a token) sealed in the vault and injected
// as one or more env vars at spawn. Accounts are GENERIC across platforms
// (RUNTIME-ACCOUNTS-V2): `anthropic` (Claude), `openai` (Codex), `google`
// (Gemini), and `custom` (any other engine — the user names the env var(s)).
//
// VAULT KEYING. Anthropic keeps its original key `ANTHROPIC_ACCOUNT__<name>`
// (zero migration for existing accounts + the Paymaster probe path); every other
// platform seals under `ACCOUNT__<PLATFORM>__<name>`. Fitting-side mirrors of the
// Anthropic prefix (stage-b.mjs, agent-sdk providers.mjs) cannot import src/lib —
// keep the literal in sync there.
//
// ANTHROPIC INJECTION VEHICLE (Phase 0 finding, claude CLI 2.1.216, verified
// live): stored /login credentials in the config dir BEAT
// CLAUDE_CODE_OAUTH_TOKEN, so the env var alone cannot switch accounts on a
// machine that has /login state. ANTHROPIC_AUTH_TOKEN beats stored credentials
// everywhere (headless, interactive PTY, Agent SDK), and the claude-pty spawn
// never strips it. So the Anthropic token is injected as ANTHROPIC_AUTH_TOKEN
// (authoritative) AND CLAUDE_CODE_OAUTH_TOKEN (belt-and-braces for
// credential-less config dirs), with ANTHROPIC_API_KEY forced empty so an
// inherited key can never outrank the plan token.

export const ANTHROPIC_ACCOUNT_PREFIX = "ANTHROPIC_ACCOUNT__";
export const GENERIC_ACCOUNT_PREFIX = "ACCOUNT__";

export type AccountPlatform =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "huggingface"
  | "glm"
  | "custom";

export const ACCOUNT_PLATFORMS: AccountPlatform[] = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "huggingface",
  "glm",
  "custom"
];

/**
 * RUNTIME-ACCOUNTS-V3 — the two shapes a credential can take.
 *
 * `token`     — an API key / bearer string injected as env var(s). One value.
 * `auth-file` — a subscription (OAuth) credential FILE the CLI owns and
 *               refreshes in place: Codex's `auth.json`, Gemini's
 *               `oauth_creds.json`. It cannot be an env var, so the account is
 *               injected by materializing a per-account CONFIG HOME and pointing
 *               the CLI at it (CODEX_HOME / GEMINI_CLI_HOME).
 */
export type CredentialKind = "token" | "auth-file";

/** How a platform's subscription credential is stored and handed to its CLI. */
export interface AuthFileSpec {
  /** Env var that relocates the CLI's whole config home. */
  homeEnvKey: string;
  /** Credential file path RELATIVE to that home. */
  relPath: string;
  /** Where the box's own native login keeps the same file (import source). */
  nativeRelPath: string;
  /** Human label for the credential, e.g. "ChatGPT subscription". */
  label: string;
  /** The command that produces it on a machine with a browser. */
  loginHint: string;
  /**
   * Files the config home needs BESIDES the credential for the CLI to actually
   * choose it. Written only when absent, so the CLI (or the user) may evolve
   * them afterwards. Gemini needs this: with `oauth_creds.json` alone it still
   * exits "Please set an Auth method in your settings.json".
   */
  companionFiles?: { relPath: string; json: unknown }[];
}

export interface PlatformSpec {
  id: AccountPlatform;
  /** Short human label for the section/select. */
  label: string;
  /** The runtimes this platform authenticates, for the UI copy. */
  runtimes: string;
  /** Env var(s) the token is injected as (empty for custom — see env_keys). */
  envKeys: string[];
  /** Env var(s) forced empty so an inherited value can't outrank the token. */
  clearKeys: string[];
  /** The box's native-login file (machine-login mode); null for custom. */
  nativeLoginPath: string | null;
  /** Placeholder shown in the token field. */
  tokenHint: string;
  /** Present when the platform supports subscription (auth-file) accounts. */
  authFile?: AuthFileSpec;
  /** Present when the CLI can mint a credential with the browser elsewhere. */
  browserLogin?: BrowserLoginSpec;
  /** Where to get an API key for this provider, and how. */
  apiKeyGuide?: ApiKeyGuide;
}

/**
 * How to obtain an API key, shown next to the field that asks for one. A key
 * input with no route to a key is a dead end - especially for a provider the
 * user has never signed up with. Every URL here was checked to resolve.
 */
export interface ApiKeyGuide {
  /** The page that creates the key. */
  url: string;
  urlLabel: string;
  /** Short ordered steps, written for someone who has never been there. */
  steps: string[];
  /** A second link worth having: billing, credits, or the token docs. */
  extra?: { url: string; label: string };
  /** What the key looks like, and what it is NOT (e.g. not the subscription). */
  note?: string;
}

/**
 * The most common OpenAI-compatible providers, for the `custom` platform. Almost
 * every third-party LLM API is a drop-in OpenAI clone that reads a single
 * `<PROVIDER>_API_KEY`, so the useful help is "here is that pattern, and here are
 * the places you most likely want".
 */
export const COMMON_CUSTOM_PROVIDERS: { name: string; envKey: string; url: string }[] = [
  { name: "Groq", envKey: "GROQ_API_KEY", url: "https://console.groq.com/keys" },
  { name: "Mistral", envKey: "MISTRAL_API_KEY", url: "https://console.mistral.ai/api-keys" },
  { name: "DeepSeek", envKey: "DEEPSEEK_API_KEY", url: "https://platform.deepseek.com/api_keys" },
  { name: "Together", envKey: "TOGETHER_API_KEY", url: "https://api.together.ai/settings/api-keys" },
  { name: "xAI", envKey: "XAI_API_KEY", url: "https://console.x.ai" }
];

/**
 * A guided login Garrison can run in a PTY on this box while the BROWSER is on
 * another machine. Both shapes avoid a localhost callback, which is the thing
 * that makes an ordinary CLI login unusable over the tailnet:
 *
 *   device-code — the CLI shows a URL + a one-time code; the user types the
 *                 code AT the site and the CLI polls. Nothing comes back here.
 *                 (`codex login --device-auth`.)
 *   paste-code  — the CLI shows a URL whose redirect is a provider-hosted page
 *                 that DISPLAYS a code; the user pastes that code back here and
 *                 Garrison types it into the PTY. (`gemini` under NO_BROWSER,
 *                 which redirects to codeassist.google.com/authcode.)
 */
export interface BrowserLoginSpec {
  command: string;
  /** Env the CLI needs to choose the headless path. */
  env?: Record<string, string>;
  flow: "device-code" | "paste-code";
  /** Button/method label, e.g. "Device login" / "Browser login". */
  label: string;
}

// The per-platform auth table. `custom` carries no fixed envKeys — the account's
// own `env_keys` list drives injection.
export const PLATFORM_SPECS: Record<AccountPlatform, PlatformSpec> = {
  anthropic: {
    id: "anthropic",
    label: "Claude / Anthropic",
    runtimes: "Claude Code and Agent SDK runtimes",
    envKeys: ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    clearKeys: ["ANTHROPIC_API_KEY"],
    nativeLoginPath: "~/.claude",
    tokenHint: "sk-ant-oat01-…",
    apiKeyGuide: {
      url: "https://console.anthropic.com/settings/keys",
      urlLabel: "Anthropic Console - API keys",
      steps: [
        "Sign in to the Anthropic Console with the account you want billed.",
        'Create Key, name it (e.g. "garrison"), then copy it - it is shown only once.',
        "Paste it below. Anthropic keys start with sk-ant-."
      ],
      extra: { url: "https://console.anthropic.com/settings/billing", label: "Billing & credits" },
      note: "An API key bills per token and is SEPARATE from a Claude Pro/Max subscription. To run on your subscription instead, use the guided login."
    },
  },
  openai: {
    id: "openai",
    label: "Codex / OpenAI",
    runtimes: "the Codex runtime (codex exec)",
    envKeys: ["OPENAI_API_KEY"],
    clearKeys: [],
    nativeLoginPath: "~/.codex/auth.json",
    tokenHint: "sk-…",
    apiKeyGuide: {
      url: "https://platform.openai.com/api-keys",
      urlLabel: "OpenAI Platform - API keys",
      steps: [
        "Sign in to the OpenAI Platform (the developer console, not ChatGPT).",
        "Create new secret key, then copy it - it is shown only once.",
        "Paste it below. OpenAI keys start with sk-."
      ],
      extra: { url: "https://platform.openai.com/settings/organization/billing", label: "Billing" },
      note: "Platform credits are SEPARATE from a ChatGPT Plus/Pro subscription. To run Codex on your subscription instead, use the device login."
    },
    authFile: {
      homeEnvKey: "CODEX_HOME",
      relPath: "auth.json",
      nativeRelPath: ".codex/auth.json",
      label: "ChatGPT subscription",
      loginHint: "codex login"
    },
    // Verified live against codex-cli 0.144.5: prints
    // https://auth.openai.com/codex/device + a one-time code, then polls.
    browserLogin: {
      command: "codex login --device-auth",
      flow: "device-code",
      label: "Device login"
    }
  },
  google: {
    id: "google",
    label: "Gemini / Google",
    runtimes: "the Gemini runtime (gemini -p)",
    envKeys: ["GEMINI_API_KEY"],
    clearKeys: [],
    nativeLoginPath: "~/.gemini/oauth_creds.json",
    tokenHint: "AIza…",
    apiKeyGuide: {
      url: "https://aistudio.google.com/apikey",
      urlLabel: "Google AI Studio - API keys",
      steps: [
        "Sign in to Google AI Studio.",
        "Create API key, and pick (or create) a Google Cloud project to attach it to.",
        "Copy it and paste it below. Google keys start with AIza."
      ],
      note: "AI Studio has a free tier; paid usage bills through the attached Google Cloud project. Separate from a Google AI Pro/Ultra subscription."
    },
    authFile: {
      homeEnvKey: "GEMINI_CLI_HOME",
      relPath: ".gemini/oauth_creds.json",
      nativeRelPath: ".gemini/oauth_creds.json",
      label: "Google AI subscription",
      loginHint: "gemini (interactive: Login with Google)",
      // gemini-cli 0.49 reads security.auth.selectedType; without it a home
      // holding valid creds still refuses to start.
      companionFiles: [
        { relPath: ".gemini/settings.json", json: { security: { auth: { selectedType: "oauth-personal" } } } }
      ]
    },
    // gemini-cli 0.49 has no `login` subcommand, but the interactive CLI under
    // NO_BROWSER prints an auth URL whose redirect_uri is Google's own
    // codeassist.google.com/authcode - NOT a localhost callback - and then
    // prompts "Enter the authorization code:". Verified live: that makes it a
    // paste-code flow Garrison can drive for a browser on any machine.
    browserLogin: {
      command: "gemini",
      env: { NO_BROWSER: "true" },
      flow: "paste-code",
      label: "Browser login"
    }
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    runtimes: "the OpenRouter runtime (345+ models behind one key)",
    envKeys: ["OPENROUTER_API_KEY"],
    clearKeys: [],
    // Pure API-key provider: no CLI, so no machine login and no auth file.
    nativeLoginPath: null,
    tokenHint: "sk-or-v1-…",
    apiKeyGuide: {
      url: "https://openrouter.ai/settings/keys",
      urlLabel: "OpenRouter - API keys",
      steps: [
        "Sign in to OpenRouter (Google/GitHub sign-in works).",
        "Create Key - optionally set a credit limit so this key can never spend more than you intend.",
        "Copy it and paste it below. OpenRouter keys start with sk-or-v1-."
      ],
      extra: { url: "https://openrouter.ai/settings/credits", label: "Buy credits" },
      note: "Credits are shared across every model OpenRouter serves. Garrison shows the remaining balance here once the key is added."
    }
  },
  huggingface: {
    id: "huggingface",
    label: "Hugging Face",
    runtimes: "the Hugging Face runtime (Inference Providers router)",
    envKeys: ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"],
    clearKeys: [],
    nativeLoginPath: null,
    tokenHint: "hf_…",
    apiKeyGuide: {
      url: "https://huggingface.co/settings/tokens",
      urlLabel: "Hugging Face - Access tokens",
      steps: [
        "Sign in to Hugging Face.",
        'New token - a Read token works; a Fine-grained token needs the "Make calls to Inference Providers" permission.',
        "Copy it and paste it below. HF tokens start with hf_."
      ],
      extra: { url: "https://huggingface.co/docs/hub/security-tokens", label: "Token docs" },
      note: "Inference Providers usage bills to your Hugging Face account; free accounts get a small monthly allowance."
    }
  },
  glm: {
    id: "glm",
    label: "GLM (self-hosted)",
    runtimes: "the OpenAI Agents runtime pointed at a self-hosted GLM endpoint",
    // A dedicated name, NOT OPENAI_API_KEY: a composition may hold both a real
    // OpenAI key and a self-hosted endpoint, and one shared name means whichever
    // key is present is sent to whichever endpoint is configured.
    envKeys: ["GLM_API_KEY"],
    clearKeys: [],
    // Self-hosted: no vendor CLI, so no machine login and no auth file.
    nativeLoginPath: null,
    tokenHint: "the bearer token your endpoint accepts",
    apiKeyGuide: {
      // There is no vendor console to link to — the endpoint is somebody's box —
      // so point at the upstream project that most commonly serves this shape.
      url: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html",
      urlLabel: "vLLM - OpenAI-compatible server (--api-key)",
      steps: [
        "Get the bearer token from whoever runs the endpoint (for vLLM/SGLang it is the value passed to --api-key).",
        "Paste it below, then set the endpoint URL on the OpenAI Agents runtime's config as baseUrl (ending in /v1).",
        "Garrison injects the token as GLM_API_KEY and only ever sends it to that configured URL."
      ],
      note: "A self-hosted endpoint has no balance or usage API, so no credit is shown here. If the endpoint is plain http:// on a public address, the token and every prompt travel unencrypted - prefer a tailnet address or a TLS terminator."
    }
  },
  custom: {
    id: "custom",
    label: "Custom",
    runtimes: "any other engine (you name the env var)",
    envKeys: [],
    clearKeys: [],
    nativeLoginPath: null,
    tokenHint: "the token value",
    apiKeyGuide: {
      url: "https://console.groq.com/keys",
      urlLabel: "Groq Console - API keys",
      steps: [
        "Create a key in your provider's own console (common ones below).",
        "Find the env var its SDK reads - almost always <PROVIDER>_API_KEY.",
        "Paste the key and that env var name below; Garrison injects it at spawn."
      ],
      note: "Nearly every third-party LLM API is OpenAI-compatible and reads a single <PROVIDER>_API_KEY, so this pattern covers most providers."
    }
  }
};

export function isAccountPlatform(value: unknown): value is AccountPlatform {
  return typeof value === "string" && (ACCOUNT_PLATFORMS as string[]).includes(value);
}

/** Normalize a possibly-absent credential kind (legacy rows = token). */
export function normalizeCredentialKind(value: unknown): CredentialKind {
  return value === "auth-file" ? "auth-file" : "token";
}

/** Which credential shapes a platform accepts (auth-file only where it exists). */
export function credentialKindsFor(platform: AccountPlatform): CredentialKind[] {
  return PLATFORM_SPECS[platform].authFile ? ["auth-file", "token"] : ["token"];
}

/**
 * Subscription credentials are JSON documents the CLI wrote. Validate the shape
 * far enough to reject a pasted API key or a truncated file, but not so far that
 * a CLI version bump bricks the import.
 */
export function parseAuthFile(
  platform: AccountPlatform,
  content: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const spec = PLATFORM_SPECS[platform].authFile;
  if (!spec) return { ok: false, error: `${platform} has no subscription-credential file` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: `not valid JSON — paste the whole ${spec.relPath} file` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `expected a JSON object (the contents of ${spec.relPath})` };
  }
  const value = parsed as Record<string, unknown>;
  // A credential with no refresh material is a dead file: it expires within the
  // hour and Garrison could never renew it.
  const hasRefresh =
    typeof value.refresh_token === "string" ||
    typeof (value.tokens as Record<string, unknown> | undefined)?.refresh_token === "string" ||
    typeof value.OPENAI_API_KEY === "string";
  if (!hasRefresh) {
    return { ok: false, error: `no refresh token in the file — is this really ${spec.relPath}?` };
  }
  return { ok: true, value };
}

/** Normalize a possibly-absent platform to a concrete one (legacy rows = anthropic). */
export function normalizePlatform(value: unknown): AccountPlatform {
  return isAccountPlatform(value) ? value : "anthropic";
}

// Lowercase slug, digits, dash/underscore; 1–32 chars. Kept strict so the name
// can safely appear in env var keys, file names and UI labels.
const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// A custom env-var NAME: conventional UPPER_SNAKE (POSIX-ish), 1–64 chars.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function isValidAccountName(name: string): boolean {
  return ACCOUNT_NAME_RE.test(name);
}

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_RE.test(key);
}

/** The vault key sealing an account's token, namespaced by platform. */
export function accountVaultKey(name: string, platform: AccountPlatform = "anthropic"): string {
  if (platform === "anthropic") return `${ANTHROPIC_ACCOUNT_PREFIX}${name}`;
  return `${GENERIC_ACCOUNT_PREFIX}${platform.toUpperCase()}__${name}`;
}

/** Parse a vault key back to { name, platform }, or null when it isn't an account key. */
export function parseAccountVaultKey(
  key: string
): { name: string; platform: AccountPlatform } | null {
  if (key.startsWith(ANTHROPIC_ACCOUNT_PREFIX)) {
    const name = key.slice(ANTHROPIC_ACCOUNT_PREFIX.length);
    return isValidAccountName(name) ? { name, platform: "anthropic" } : null;
  }
  if (key.startsWith(GENERIC_ACCOUNT_PREFIX)) {
    const rest = key.slice(GENERIC_ACCOUNT_PREFIX.length);
    const sep = rest.indexOf("__");
    if (sep <= 0) return null;
    const platform = rest.slice(0, sep).toLowerCase();
    const name = rest.slice(sep + 2);
    if (!isAccountPlatform(platform) || platform === "anthropic") return null;
    return isValidAccountName(name) ? { name, platform } : null;
  }
  return null;
}

/** Back-compat: the name for any account-shaped key (used where platform is implicit). */
export function accountNameFromVaultKey(key: string): string | null {
  const parsed = parseAccountVaultKey(key);
  return parsed ? parsed.name : null;
}

// Loose sanity check on an ANTHROPIC token VALUE (never logged): all Anthropic
// bearer shapes start sk-ant- (setup-token prints sk-ant-oat01-…). Deliberately
// loose so a future token prefix does not brick the registry.
export function looksLikeAnthropicToken(token: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{8,}$/.test(token.trim());
}

/**
 * The env-var block that pins a spawned session to the named account. Anthropic
 * keeps its exact two-token + cleared-key shape; other platforms inject the
 * token into their platform env var(s); custom uses the account's own env_keys.
 */
export function accountAuthEnv(
  name: string,
  token: string,
  platform: AccountPlatform = "anthropic",
  customEnvKeys?: string[]
): Record<string, string> {
  const spec = PLATFORM_SPECS[platform];
  const keys = platform === "custom" ? (customEnvKeys ?? []) : spec.envKeys;
  const env: Record<string, string> = {
    // Non-secret marker: which account this session was launched under
    // (surfaced in logs and the 401 needs-relogin flagging).
    GARRISON_ACCOUNT: name
  };
  for (const key of keys) env[key] = token;
  // Empty (not merely absent): an inherited raw key would outrank the token.
  for (const key of spec.clearKeys) env[key] = "";
  return env;
}

/**
 * The env-var block for an AUTH-FILE account: point the CLI's config home at the
 * per-account directory the caller materialized. The credential never becomes an
 * env var — the CLI reads (and refreshes) it in that home, exactly as it would
 * its own. The instance launcher already exports CODEX_HOME / GEMINI_CLI_HOME,
 * so this simply overrides them for the pinned account.
 */
export function accountHomeEnv(
  name: string,
  platform: AccountPlatform,
  homeDir: string
): Record<string, string> {
  const spec = PLATFORM_SPECS[platform].authFile;
  if (!spec) return { GARRISON_ACCOUNT: name };
  const env: Record<string, string> = {
    GARRISON_ACCOUNT: name,
    [spec.homeEnvKey]: homeDir
  };
  // An auth-file selection is an exclusive credential source. Explicitly empty
  // every token rail for the platform so a launcher/global API key cannot take
  // precedence over the materialized subscription login.
  for (const key of PLATFORM_SPECS[platform].envKeys) env[key] = "";
  for (const key of PLATFORM_SPECS[platform].clearKeys) env[key] = "";
  return env;
}
