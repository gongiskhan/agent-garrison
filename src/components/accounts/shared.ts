// shared.ts — RUNTIME-ACCOUNTS UX: the client-side vocabulary shared by the
// compact runtime picker (AccountField) and the dedicated Accounts surface
// (AccountsManager). Types mirror the /api/accounts, /api/accounts/paymaster and
// /api/accounts/machine-login payloads. Numbers and statuses only — token values
// never reach the browser. Platform vocabulary is imported from the pure
// account-env module so there is one source of truth.

import {
  ACCOUNT_PLATFORMS,
  COMMON_CUSTOM_PROVIDERS,
  PLATFORM_SPECS,
  type AccountPlatform,
  type CredentialKind
} from "@/lib/account-env";

export type { AccountPlatform, CredentialKind };
export { ACCOUNT_PLATFORMS, COMMON_CUSTOM_PROVIDERS, PLATFORM_SPECS };

/**
 * How the user gets a credential into the vault for a platform. Which of these
 * are offered is a fact about the CLI, not a preference:
 *   setup-token — Anthropic prints a long-lived token (`claude setup-token`).
 *   device      — the CLI mints one from a URL + code with no localhost
 *                 callback, so a browser on ANOTHER machine can complete it
 *                 (Codex). This is the only remote-friendly subscription login.
 *   import      — adopt this box's own CLI login as a named account.
 *   paste-auth  — paste a credential file exported from another machine.
 *   paste-token — an API key.
 */
export type AddMethod = "setup-token" | "browser" | "import" | "paste-auth" | "paste-token";

export interface AddMethodOption {
  id: AddMethod;
  label: string;
  blurb: string;
}

/** The methods a platform actually supports, best first. */
export function addMethodsFor(platform: AccountPlatform): AddMethodOption[] {
  const spec = PLATFORM_SPECS[platform];
  const methods: AddMethodOption[] = [];
  if (platform === "anthropic") {
    methods.push({
      id: "setup-token",
      label: "Guided login",
      blurb: "Runs `claude setup-token` here and captures the long-lived token. Authorize in any browser."
    });
  }
  if (spec.browserLogin) {
    methods.push({
      id: "browser",
      label: spec.browserLogin.label,
      blurb:
        spec.browserLogin.flow === "device-code"
          ? `Runs \`${spec.browserLogin.command}\` here: you get a link and a one-time code to enter from any browser, on any machine. Captures the ${spec.authFile?.label ?? "credential"}.`
          : `Runs \`${spec.browserLogin.command}\` here in headless mode: you get a link to authorize from any browser, then paste the code it shows back here. Captures the ${spec.authFile?.label ?? "credential"}.`
    });
  }
  if (spec.authFile) {
    methods.push({
      id: "import",
      label: "Import this box's login",
      blurb: `Copies the login this machine already has (${spec.nativeLoginPath}) into the vault as a named account. The box's own login is left untouched.`
    });
    methods.push({
      id: "paste-auth",
      label: "Paste a credential file",
      blurb: `Paste the contents of ${spec.nativeLoginPath} from a machine where you ran \`${spec.authFile.loginHint}\`.`
    });
  }
  methods.push({
    id: "paste-token",
    label: platform === "custom" ? "Paste a token" : "Paste an API key",
    blurb:
      platform === "custom"
        ? "Seal any token and name the env var(s) it is injected as."
        : `Billed per token, separate from any subscription. Injected as ${spec.envKeys.join(" + ") || "the env var you name"}.`
  });
  return methods;
}

/** Short badge text for how an account authenticates. */
export function credentialLabel(account: AccountInfo): string {
  if (account.credential_kind === "auth-file") {
    return PLATFORM_SPECS[account.platform].authFile?.label ?? "subscription";
  }
  return account.platform === "anthropic" ? "setup token" : "API key";
}

export interface AccountInfo {
  name: string;
  label?: string;
  created_at: string;
  needs_relogin?: boolean;
  status: "ready" | "missing-token" | "vault-locked";
  ageDays: number | null;
  enabled: boolean;
  ceiling: number;
  /** anthropic | openai | google | custom (legacy rows resolve to anthropic). */
  platform: AccountPlatform;
  /** token (env-var key) | auth-file (subscription credential + config home). */
  credential_kind: CredentialKind;
  /** Custom platform: the env var name(s) the token is injected as. */
  env_keys?: string[];
  /** Last verification verdict, kept so the roster can explain a stuck account. */
  last_verify?: { outcome: string; detail: string; at: string };
}

/** Per-platform section copy for the /accounts surface (what pinning does). */
export const PLATFORM_SECTIONS: {
  id: AccountPlatform;
  label: string;
  blurb: string;
}[] = [
  {
    id: "anthropic",
    label: "Claude / Anthropic",
    blurb:
      "Claude accounts (from `claude setup-token` or a pasted token). Pin one to a Claude Code or Agent SDK runtime, or let Auto rotate across them by rate-limit usage. Injected as ANTHROPIC_AUTH_TOKEN."
  },
  {
    id: "openai",
    label: "Codex / OpenAI",
    blurb:
      "Accounts for the Codex runtime (`codex exec`), on your ChatGPT subscription or an API key. A subscription account is captured by device login (a link + a one-time code you enter from any browser) and runs in its own CODEX_HOME; an API key is injected as OPENAI_API_KEY. Pin one to authenticate Codex whether it is the primary or a delegate target."
  },
  {
    id: "google",
    label: "Gemini / Google",
    blurb:
      "Accounts for the Gemini runtime (`gemini -p`, incl. image/video), on a Google subscription or an API key. Gemini's CLI has no headless login, so a subscription account is imported from a machine that has already signed in; it then runs in its own GEMINI_CLI_HOME. An API key is injected as GEMINI_API_KEY."
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb:
      "One key, 345+ models from every major lab (and the long tail) behind a single OpenAI-compatible endpoint. Pin an account to the OpenRouter runtime and pick a model there. Injected as OPENROUTER_API_KEY. OpenRouter reports a real credit balance, shown below."
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    blurb:
      "Open-weight models through Hugging Face's Inference Providers router (OpenAI-compatible). Pin an account to the Hugging Face runtime and pick a model there. Injected as HF_TOKEN + HUGGING_FACE_HUB_TOKEN."
  },
  {
    id: "glm",
    label: "GLM (self-hosted)",
    blurb:
      "A GLM deployment behind your own OpenAI-compatible server (vLLM / SGLang). Pin an account to the OpenAI Agents runtime with provider `glm`, and set the endpoint as that runtime's baseUrl. Injected as GLM_API_KEY, and only ever sent to the configured URL. No balance API - a self-hosted box does not report one."
  },
  {
    id: "custom",
    label: "Custom",
    blurb:
      "Any other engine. You name the env var(s) the token is injected as (e.g. MISTRAL_API_KEY) and pin the account to a runtime that reads them."
  }
];

/** Mirrors AccountBalance in src/lib/account-balance.ts. */
export interface AccountBalance {
  label: string;
  usedPct: number | null;
  detail: string;
  kind: "available" | "identity" | "unavailable";
  fetchedAt: string;
}

export interface UsageWindow {
  pct: number;
  resetAt: string | null;
  status: string | null;
}

export interface AccountUsage {
  fiveHour: UsageWindow;
  weekly: UsageWindow;
  status: string | null;
  probedAt: string;
  error?: string;
}

export interface JudgedCandidate {
  name: string;
  enabled: boolean;
  ceiling: number;
  tokenReady: boolean;
  usage: AccountUsage | null;
  effectivePct: number | null;
  eligible: boolean;
  reason: string | null;
}

export interface PaymasterPayload {
  accounts: AccountInfo[];
  decision: {
    pick: string | null;
    candidates: JudgedCandidate[];
    nearestResetAt: string | null;
  };
  settings: { freshnessTtlMinutes: number; probeIntervalMinutes: number };
}

/** Mirrors LoginVerify in src/lib/account-login.ts. */
export interface LoginVerify {
  ok: boolean;
  outcome:
    | "verified"
    | "rate-limited"
    | "rejected"
    | "not-entitled"
    | "unverifiable"
    | "inconclusive";
  detail: string;
  usage?: { fiveHourPct: number; weeklyPct: number; resetAt: string | null } | null;
}

/** Headline + tone for a verify verdict, shared by the guided and paste flows. */
export function verifyChip(verify: LoginVerify | null | undefined): StatusChip {
  switch (verify?.outcome) {
    case "verified":
      return { tone: "ok", label: "Account ready", detail: verify.detail };
    case "rate-limited":
      return { tone: "warn", label: "Token valid, account at its limit", detail: verify.detail };
    case "rejected":
      return { tone: "alarm", label: "Token rejected", detail: verify.detail };
    case "not-entitled":
      // The login is fine; the plan is the problem. Saying "rejected" here would
      // send the user back to a login flow that cannot help them.
      return { tone: "warn", label: "Logged in, but the plan doesn't cover it", detail: verify.detail };
    case "unverifiable":
      return { tone: "mute", label: "Sealed, not verified", detail: verify.detail };
    case "inconclusive":
      return { tone: "warn", label: "Sealed, could not verify", detail: verify.detail };
    default:
      return { tone: "mute", label: "Sealed in the vault", detail: "no probe result" };
  }
}

export interface LoginStatus {
  id: string;
  accountName: string;
  state: string;
  mode?: string;
  /** Device flow: the one-time code to type at the verification URL. */
  userCode?: string | null;
  authorizeUrl: string | null;
  outputTail: string;
  error: string | null;
  verify: LoginVerify | null;
}

export interface PlatformLogin {
  platform: AccountPlatform;
  loggedIn: boolean;
  email: string | null;
  displayName: string | null;
  organizationName: string | null;
  plan: string | null;
  subscriptionType: string | null;
  expiresAt: string | null;
  expired: boolean;
  source: "credentials" | "profile-only" | "none";
  configPath: string;
  /** This instance reads an isolated config home (dev/codex), not the host's. */
  isolatedHome: boolean;
  /** The host's real path for this platform (what the prod instance reads). */
  hostConfigPath: string;
}

// Back-compat alias for the compact picker's simple (anthropic) case.
export type MachineLogin = PlatformLogin;

// ── status chips ─────────────────────────────────────────────────────────────
// Monochrome-with-accent, matching the paper/ink system: sage = good, alarm =
// broken, warn = attention, mute = neutral/disabled. No invented greens.
export type ChipTone = "ok" | "alarm" | "warn" | "mute";

export const CHIP_COLOR: Record<ChipTone, string> = {
  ok: "var(--sage)",
  alarm: "var(--alarm)",
  warn: "var(--warn)",
  mute: "var(--mute)"
};

export interface StatusChip {
  label: string;
  tone: ChipTone;
  detail: string;
}

/** The single login-status verdict for a registered account (roster + picker). */
export function accountStatusChip(account: AccountInfo): StatusChip {
  if (account.status === "vault-locked") {
    return { tone: "mute", label: "Vault locked", detail: "unlock the vault to use this account" };
  }
  if (account.needs_relogin) {
    return {
      tone: "alarm",
      label: "Needs re-login",
      detail: "a session under this account hit an auth error - log in again"
    };
  }
  if (account.status === "missing-token") {
    return { tone: "warn", label: "No token", detail: "no token in the vault - log in again" };
  }
  // An account can be genuinely logged in and still unusable. Keep saying so
  // rather than showing a green "Logged in" that the next run will contradict.
  if (account.last_verify?.outcome === "not-entitled") {
    return {
      tone: "warn",
      label: "Plan doesn't cover it",
      detail: account.last_verify.detail
    };
  }
  // Age copy differs by credential: a setup token is long-lived and its age is
  // the useful signal; a subscription credential is refreshed by its own CLI, so
  // "0d old" would be meaningless there.
  if (account.credential_kind === "auth-file") {
    return {
      tone: "ok",
      label: "Logged in",
      detail: "subscription credential sealed in the vault; the CLI refreshes it in its own config home"
    };
  }
  return {
    tone: "ok",
    label: "Logged in",
    detail:
      account.ageDays !== null
        ? `token ${account.ageDays}d old${account.platform === "anthropic" ? " (setup tokens last about a year)" : ""}`
        : "token sealed in the vault"
  };
}

// The command that re-establishes each platform's native login on the host.
const NATIVE_LOGIN_CMD: Record<AccountPlatform, string> = {
  anthropic: "claude /login",
  openai: "codex login",
  google: "gemini",
  // Key-only providers have no CLI login to run.
  openrouter: "",
  huggingface: "",
  glm: "",
  custom: ""
};

/** The login-status verdict for the box's own native login on a platform. */
export function machineStatusChip(machine: PlatformLogin): StatusChip {
  const cmd = NATIVE_LOGIN_CMD[machine.platform] || "the CLI login";
  if (machine.loggedIn) {
    return {
      tone: machine.expired ? "warn" : "ok",
      label: machine.expired ? "Token expiring" : "Logged in",
      detail: machine.expired
        ? "the stored credential is past its expiry - it refreshes on next use"
        : "a live credential is present in this instance's config home"
    };
  }
  if (machine.source === "profile-only") {
    return {
      tone: "warn",
      label: "Signed out",
      detail: `a cached profile remains but no live credential - run \`${cmd}\` on the host`
    };
  }
  // An isolated instance (dev/codex) is pointed AWAY from the host's config on
  // purpose, so "not logged in" here says nothing about the host. Don't cry
  // wolf: report the profile fact, not a missing credential.
  if (machine.isolatedHome) {
    return {
      tone: "mute",
      label: "Not in this instance",
      detail: `this instance reads its own isolated config home, not ${machine.hostConfigPath} - only the prod instance uses the host login`
    };
  }
  return {
    tone: "mute",
    label: "Not logged in",
    detail: `this box has no ${machine.platform} login - run \`${cmd}\` on the host`
  };
}

/**
 * Copy text in BOTH secure and insecure contexts. Garrison is reached over the
 * tailnet AND over plain http:// at the box's tailscale/LAN address, where
 * `navigator.clipboard` is undefined (secure-context only) - calling it there
 * throws "Cannot read properties of undefined (reading 'writeText')".
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

export function accountOptionLabel(account: AccountInfo): string {
  const bits = [account.name];
  if (account.label) bits.push(account.label);
  // Which plan an engine runs on is the first thing you want to see in a picker.
  if (account.platform !== "anthropic") bits.push(credentialLabel(account));
  else if (account.ageDays !== null) bits.push(`${account.ageDays}d old`);
  if (account.needs_relogin) bits.push("RE-LOGIN NEEDED");
  else if (account.status !== "ready") bits.push(account.status);
  return bits.join(" · ");
}

export function formatCountdown(resetAt: string | null, now: number): string {
  if (!resetAt) return "";
  const ms = Date.parse(resetAt) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "resets now";
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `resets in ${minutes}m`;
}

export function formatAgo(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Count of accounts the Paymaster may actually rotate to right now. */
export function eligibleRotationCount(accounts: AccountInfo[]): number {
  return accounts.filter((a) => a.enabled && a.status === "ready" && !a.needs_relogin).length;
}

/**
 * Which account platform a runtime fitting authenticates with — so the compact
 * picker filters the pin list and hides Auto for non-Anthropic engines. Derived
 * from the runtime's provided name (falling back to the fitting id): the seed
 * runtimes are claude-code/agent-sdk (anthropic), codex (openai), gemini (google).
 */
export function platformForRuntime(
  fittingId: string,
  runtimeName?: string,
  /**
   * The runtime's selected PROVIDER, when it has one. Some engines are an endpoint
   * FAMILY rather than a vendor — openai-agents fronts OpenAI cloud, a local
   * Ollama and a self-hosted GLM box — so the fitting id alone cannot say which
   * credential authenticates it, and guessing would offer a pin that injects a key
   * the endpoint rejects.
   */
  provider?: string
): AccountPlatform {
  const s = `${runtimeName ?? ""} ${fittingId}`.toLowerCase();
  if (s.includes("openai-agents")) {
    const p = (provider ?? "").trim().toLowerCase();
    if (p === "glm") return "glm";
    // `ollama-local` is keyless; there is no account to pin, and "anthropic" would
    // be actively wrong. Fall through to openai, the only keyed vendor here.
    return "openai";
  }
  if (s.includes("codex")) return "openai";
  if (s.includes("gemini")) return "google";
  if (s.includes("openrouter")) return "openrouter";
  if (s.includes("huggingface") || s.includes("hugging-face")) return "huggingface";
  return "anthropic";
}
