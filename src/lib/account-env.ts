// account-env.ts — RUNTIME-ACCOUNTS-V1: the pure vocabulary of Anthropic
// runtime accounts. No I/O here — this module is imported by the pure spawn-env
// builders (runtime-selection.ts) as well as the registry (accounts.ts), so it
// must stay side-effect free.
//
// An "account" is a named long-lived Anthropic OAuth token (from
// `claude setup-token`) sealed in the vault under ANTHROPIC_ACCOUNT__<name>.
// Fitting-side mirrors of the prefix (stage-b.mjs, agent-sdk providers.mjs)
// cannot import src/lib — keep the literal in sync there.
//
// INJECTION VEHICLE (Phase 0 finding, claude CLI 2.1.216, verified live):
// stored /login credentials in the config dir BEAT CLAUDE_CODE_OAUTH_TOKEN, so
// the brief's D3 env var alone cannot switch accounts on a machine that has
// /login state. ANTHROPIC_AUTH_TOKEN beats stored credentials everywhere
// (headless, interactive PTY, Agent SDK — the CLI itself warns "another auth
// source is set and takes precedence over your claude.ai login"), and the
// claude-pty spawn deliberately never strips it. So the account token is
// injected as ANTHROPIC_AUTH_TOKEN (authoritative) AND CLAUDE_CODE_OAUTH_TOKEN
// (belt-and-braces for credential-less config dirs), with ANTHROPIC_API_KEY
// forced empty so an inherited key can never outrank the plan token.

export const ANTHROPIC_ACCOUNT_PREFIX = "ANTHROPIC_ACCOUNT__";

// Lowercase slug, digits, dash/underscore; 1–32 chars. Kept strict so the name
// can safely appear in env var keys, file names and UI labels.
const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidAccountName(name: string): boolean {
  return ACCOUNT_NAME_RE.test(name);
}

export function accountVaultKey(name: string): string {
  return `${ANTHROPIC_ACCOUNT_PREFIX}${name}`;
}

export function accountNameFromVaultKey(key: string): string | null {
  if (!key.startsWith(ANTHROPIC_ACCOUNT_PREFIX)) return null;
  const name = key.slice(ANTHROPIC_ACCOUNT_PREFIX.length);
  return isValidAccountName(name) ? name : null;
}

// Loose sanity check on a token VALUE (never logged): all Anthropic bearer
// shapes start sk-ant- (setup-token prints sk-ant-oat01-…). Deliberately loose
// so a future token prefix does not brick the registry.
export function looksLikeAnthropicToken(token: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{8,}$/.test(token.trim());
}

/** The env-var block that pins a spawned session to the named account. */
export function accountAuthEnv(name: string, token: string): Record<string, string> {
  return {
    ANTHROPIC_AUTH_TOKEN: token,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    // Empty (not merely absent): an inherited raw API key would both outrank
    // the plan token and bill the API pool.
    ANTHROPIC_API_KEY: "",
    // Non-secret marker: which account this session was launched under
    // (surfaced in logs and the 401 needs-relogin flagging).
    GARRISON_ACCOUNT: name
  };
}
