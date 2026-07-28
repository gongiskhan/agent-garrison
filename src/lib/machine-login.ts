// machine-login.ts — RUNTIME-ACCOUNTS UX: read the identity + login status of
// the BOX'S OWN native login per platform (what the "Machine login" runtime mode
// launches under), for display only. Never reads or returns token VALUES — only
// whether a live credential is present, plus the non-secret profile fields the
// CLIs cache.
//
//   anthropic — ~/.claude.json `oauthAccount` (email, plan) + ~/.claude/.credentials.json
//               `claudeAiOauth`. Profile-safe via GARRISON_CLAUDE_HOME.
//   openai    — ~/.codex/auth.json (OPENAI_API_KEY / OAuth tokens).
//   google    — ~/.gemini/oauth_creds.json (Google OAuth).
//
// Codex/Gemini identity is not richly parsed (the files carry opaque tokens) —
// we report presence only, which is the honest "is the box logged in" answer.

import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { claudeHome, claudeJsonPath } from "./claude-home";
import type { AccountPlatform } from "./account-env";

export interface PlatformLogin {
  /** anthropic | openai | google — the native-login platforms (custom has none). */
  platform: Exclude<AccountPlatform, "custom">;
  /** A live credential is present in the config dir (the real "logged in" signal). */
  loggedIn: boolean;
  /** Cached account email (anthropic only today); null otherwise. */
  email: string | null;
  displayName: string | null;
  organizationName: string | null;
  /** Prettified plan label, e.g. "Max 20×" / "Pro"; null when unknown. */
  plan: string | null;
  /** Raw subscription type ("max", "pro", …); null when unknown. */
  subscriptionType: string | null;
  /** Credential token expiry (ISO); null when no credential/expiry present. */
  expiresAt: string | null;
  /** The stored credential has passed its expiry (it refreshes on next use). */
  expired: boolean;
  /**
   * credentials  — a live token is present (truly logged in).
   * profile-only — a cached profile exists but no credential (signed out / stale).
   * none         — neither; a fresh box.
   */
  source: "credentials" | "profile-only" | "none";
  /** Which config file/dir this reflects (shown so the surface is unambiguous). */
  configPath: string;
  /**
   * This instance reads an ISOLATED config home, not the box's real one — the
   * dev/codex profiles are pointed away from `~/.claude` on purpose (only prod
   * owns it). Without this the surface reads "Not logged in" while the host is
   * perfectly logged in, and the honest explanation is a profile fact, not a
   * credential fact.
   */
  isolatedHome: boolean;
  /** The box's real config path for this platform (what prod reads). */
  hostConfigPath: string;
}

// Back-compat alias for the anthropic reader's original name.
export type MachineLogin = PlatformLogin;

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

// Codex/Gemini config homes — the box's REAL native login (Garrison seeds an
// isolated runtime copy from these). Home-relative, overridable for tests.
function codexAuthPath(): string {
  const override = process.env.GARRISON_CODEX_HOME?.trim();
  return path.join(override && override.length > 0 ? override : path.join(homedir(), ".codex"), "auth.json");
}
function geminiCredsPath(): string {
  const override = process.env.GARRISON_GEMINI_HOME?.trim();
  return path.join(override && override.length > 0 ? override : path.join(homedir(), ".gemini"), "oauth_creds.json");
}

/**
 * The box's own credential FILE for a subscription platform - the import source
 * for "add this box's login as an account". Honors the same test/profile
 * overrides as the login readers, so an isolated instance imports its own.
 */
export function nativeCredentialPath(platform: "openai" | "google"): string {
  return platform === "openai" ? codexAuthPath() : geminiCredsPath();
}

/** Where this platform's login lives on the host itself (prod's view). */
function hostPathFor(platform: PlatformLogin["platform"]): string {
  if (platform === "anthropic") return path.join(homedir(), ".claude");
  if (platform === "openai") return path.join(homedir(), ".codex", "auth.json");
  return path.join(homedir(), ".gemini", "oauth_creds.json");
}

/** Prettify Claude's plan tier from the credential/profile fields. */
export function planLabel(
  subscriptionType: string | null,
  rateLimitTier: string | null
): string | null {
  const tier = (rateLimitTier ?? "").toLowerCase();
  const max = tier.match(/max[_-]?(\d+)x/);
  if (max) return `Max ${max[1]}×`;
  if (tier.includes("max")) return "Max";
  if (tier.includes("pro")) return "Pro";
  if (tier.includes("team")) return "Team";
  const sub = (subscriptionType ?? "").toLowerCase();
  if (!sub) return null;
  if (sub === "max") return "Max";
  if (sub === "pro") return "Pro";
  return sub.charAt(0).toUpperCase() + sub.slice(1);
}

/** Anthropic (Claude) native login — rich identity from ~/.claude(.json). */
export async function readMachineLogin(): Promise<PlatformLogin> {
  const home = claudeHome();
  const [config, creds] = await Promise.all([
    readJson(claudeJsonPath(home)),
    readJson(path.join(home, ".credentials.json"))
  ]);

  const account = (config?.oauthAccount as Record<string, unknown> | undefined) ?? undefined;
  const oauth = (creds?.claudeAiOauth as Record<string, unknown> | undefined) ?? undefined;

  const hasCredential = Boolean(
    oauth && typeof oauth.accessToken === "string" && (oauth.accessToken as string).length > 0
  );
  const expiresRaw =
    oauth && typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
      ? (oauth.expiresAt as number)
      : null;

  const subscriptionType = oauth ? str(oauth.subscriptionType) : null;
  const rateLimitTier =
    (account ? str(account.organizationRateLimitTier) : null) ??
    (oauth ? str(oauth.rateLimitTier) : null);

  return {
    platform: "anthropic",
    loggedIn: hasCredential,
    email: account ? str(account.emailAddress) : null,
    displayName: account ? str(account.displayName) : null,
    organizationName: account ? str(account.organizationName) : null,
    plan: planLabel(subscriptionType, rateLimitTier),
    subscriptionType,
    expiresAt: expiresRaw !== null ? new Date(expiresRaw).toISOString() : null,
    expired: expiresRaw !== null ? Date.now() > expiresRaw : false,
    source: hasCredential ? "credentials" : account ? "profile-only" : "none",
    configPath: home,
    isolatedHome: home !== hostPathFor("anthropic"),
    hostConfigPath: hostPathFor("anthropic")
  };
}

/** A presence-only native-login reader for the non-Anthropic CLIs. */
async function readNativePresence(
  platform: Exclude<AccountPlatform, "custom" | "anthropic">,
  file: string,
  hasCredential: (json: Record<string, unknown>) => boolean
): Promise<PlatformLogin> {
  const json = await readJson(file);
  const loggedIn = Boolean(json && hasCredential(json));
  return {
    platform,
    loggedIn,
    email: null,
    displayName: null,
    organizationName: null,
    plan: null,
    subscriptionType: null,
    expiresAt: null,
    expired: false,
    source: loggedIn ? "credentials" : "none",
    configPath: file,
    isolatedHome: file !== hostPathFor(platform),
    hostConfigPath: hostPathFor(platform)
  };
}

/** Codex (OpenAI) native login — ~/.codex/auth.json (API key or OAuth tokens). */
export function readCodexLogin(): Promise<PlatformLogin> {
  return readNativePresence("openai", codexAuthPath(), (j) => {
    if (typeof j.OPENAI_API_KEY === "string" && j.OPENAI_API_KEY) return true;
    const tokens = j.tokens as Record<string, unknown> | undefined;
    return Boolean(tokens && typeof tokens.access_token === "string" && tokens.access_token);
  });
}

/** Gemini (Google) native login — ~/.gemini/oauth_creds.json (Google OAuth). */
export function readGeminiLogin(): Promise<PlatformLogin> {
  return readNativePresence("google", geminiCredsPath(), (j) => {
    return typeof j.access_token === "string" && Boolean(j.access_token);
  });
}

/** Every known platform's box login, in section order (custom has none). */
export async function readMachineLogins(): Promise<PlatformLogin[]> {
  return Promise.all([readMachineLogin(), readCodexLogin(), readGeminiLogin()]);
}
