// account-login.ts — RUNTIME-ACCOUNTS-V1 D2: the guided setup-token login flow.
//
// The Next server cannot host node-pty in its bundle, so each login attempt is
// a detached helper process (scripts/account-login-pty.mjs) speaking a small
// file protocol under <garrison home>/account-login/<id>/. This module owns
// the server side: start/status/code/cancel, and the finalize step that moves
// a captured token from the helper's 0600 file into the vault (deleting the
// file), then runs a live verify probe under the new token. Token values never
// appear in any status payload.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { garrisonDir } from "./claude-home";
import { ROOT_DIR } from "./paths";
import {
  addAccount,
  identityFromCredential,
  materializeAccountHome,
  setAccountIdentity,
  setAccountNeedsRelogin,
  setAccountVerdict
} from "./accounts";
import {
  PLATFORM_SPECS,
  parseAuthFile,
  isRotatingCredential,
  type AccountPlatform,
  type CredentialKind
} from "./account-env";
import { nativeCredentialPath } from "./machine-login";
import { cacheUsage, probeAccountUsage, PaymasterProbeAuthError } from "./paymaster";

/**
 * The verdict of the post-capture verification probe.
 *
 * `outcome` is the honest classification; `ok` answers only "is this token
 * usable at all". They differ on `rate-limited`: a 429 PROVES the token
 * authenticated (you cannot be rate-limited anonymously), so the login
 * succeeded even though the account cannot serve a request this minute.
 */
export interface LoginVerify {
  ok: boolean;
  outcome:
    | "verified" /** the provider accepted the token */
    | "rate-limited" /** valid token, account at its usage limit right now */
    | "rejected" /** the provider refused the token (401/403) — re-login */
    | "not-entitled" /** the login WORKED; the account's plan doesn't cover this */
    | "unverifiable" /** no probe exists for this platform (custom) */
    | "inconclusive"; /** the probe could not reach the provider */
  detail: string;
  /** Anthropic only: the numbers the same probe returns to the Paymaster. */
  usage?: { fiveHourPct: number; weeklyPct: number; resetAt: string | null } | null;
}

/**
 * setup-token - Anthropic's long-lived token printed to the terminal.
 * generic     - a runtime's own native login (no capture; D6 best-effort).
 * browser     - a CLI login completed in a browser on ANOTHER machine, captured
 *               as an auth-file account (V3/V4). Two flows: device-code (codex)
 *               and paste-code (gemini) - see BrowserLoginSpec.
 */
export type LoginMode = "setup-token" | "generic" | "browser";

export interface LoginStatus {
  id: string;
  accountName: string;
  mode: LoginMode;
  /** device-code flow: the one-time code to type at the verification URL. */
  userCode: string | null;
  /** Helper-reported state, overlaid with the server's finalize progress. */
  state:
    | "starting"
    | "running"
    | "awaiting-browser"
    | "captured"
    | "verifying"
    | "done"
    | "finished"
    | "cancelled"
    | "error";
  authorizeUrl: string | null;
  outputTail: string;
  error: string | null;
  verify: LoginVerify | null;
}

interface LoginRuntimeEntry {
  accountName: string;
  label?: string;
  mode: LoginMode;
  platform?: AccountPlatform;
  finalize?: "pending" | "verifying" | "done" | "failed";
  verify?: LoginVerify | null;
  finalizeError?: string;
}

interface LoginRuntime {
  sessions: Map<string, LoginRuntimeEntry>;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentGarrisonAccountLogin: LoginRuntime | undefined;
}

function runtime(): LoginRuntime {
  globalThis.__agentGarrisonAccountLogin ??= { sessions: new Map() };
  return globalThis.__agentGarrisonAccountLogin;
}

function loginDir(id: string): string {
  return path.join(garrisonDir(), "account-login", id);
}

const ID_RE = /^[a-f0-9]{16}$/;

export async function startLogin(options: {
  accountName: string;
  label?: string;
  mode?: LoginMode;
  command?: string;
  /** browser mode: which platform's guided login to run. */
  platform?: AccountPlatform;
}): Promise<{ id: string }> {
  const id = randomBytes(8).toString("hex");
  const dir = loginDir(id);
  await fs.mkdir(dir, { recursive: true });
  const mode: LoginMode = options.mode ?? "setup-token";
  const helper = path.join(ROOT_DIR, "scripts", "account-login-pty.mjs");
  const args = [helper, "--dir", dir, "--mode", mode];
  const platform = options.platform ?? "anthropic";
  if (mode === "generic" && options.command) args.push("--command", options.command);
  if (mode === "browser") {
    const spec = PLATFORM_SPECS[platform];
    if (!spec.browserLogin || !spec.authFile) {
      throw new Error(`${platform} has no browser login`);
    }
    // The capture runs in a throwaway home under the login dir, so a cancelled
    // or failed attempt leaves nothing behind and the box's own login is never
    // touched. The credential moves to the vault at finalize.
    const home = path.join(dir, "home");
    // Seed the home's companions FIRST: gemini refuses to start (and so never
    // reaches its OAuth prompt) unless security.auth.selectedType is already set.
    for (const companion of spec.authFile.companionFiles ?? []) {
      const target = path.join(home, companion.relPath);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, `${JSON.stringify(companion.json, null, 2)}\n`, { mode: 0o600 });
    }
    args.push(
      "--command",
      spec.browserLogin.command,
      "--flow",
      spec.browserLogin.flow,
      "--home",
      home,
      "--home-env",
      spec.authFile.homeEnvKey,
      "--capture-file",
      spec.authFile.relPath
    );
    for (const [key, value] of Object.entries(spec.browserLogin.env ?? {})) {
      args.push("--env", `${key}=${value}`);
    }
  }
  const child = spawn("node", args, {
    cwd: ROOT_DIR,
    detached: true,
    stdio: "ignore",
    env: { ...process.env }
  });
  child.unref();
  runtime().sessions.set(id, {
    accountName: options.accountName,
    label: options.label,
    mode,
    platform
  });
  return { id };
}

async function readHelperStatus(id: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(loginDir(id), "status.json"), "utf8"));
  } catch {
    return null;
  }
}

// Move a captured token into the vault exactly once, then verify it live. The
// helper's token file is deleted the moment it is read.
async function finalizeCapture(id: string, entry: LoginRuntimeEntry): Promise<void> {
  if (entry.finalize) return;
  const tokenPath = path.join(loginDir(id), "token.txt");
  if (!existsSync(tokenPath)) return;
  entry.finalize = "pending";
  // A browser login captures a credential FILE; setup-token captures a string.
  const kind: CredentialKind = entry.mode === "browser" ? "auth-file" : "token";
  const platform = entry.platform ?? "anthropic";
  let token: string;
  try {
    token = (await fs.readFile(tokenPath, "utf8")).trim();
    await fs.unlink(tokenPath);
    await addAccount({
      name: entry.accountName,
      token,
      label: entry.label,
      platform,
      credential_kind: kind
    });
  } catch (error) {
    entry.finalize = "failed";
    entry.finalizeError = error instanceof Error ? error.message : String(error);
    return;
  }
  // The throwaway capture home has served its purpose - the credential is in
  // the vault now, so don't leave a second copy lying in the login dir.
  await fs.rm(path.join(loginDir(id), "home"), { recursive: true, force: true }).catch(
    () => undefined
  );
  entry.finalize = "verifying";
  entry.verify = null;
  // Never let a verify surprise strand the dialog in "verifying" forever.
  const verify = await verifyAccountToken(entry.accountName, token, platform, fetch, kind).catch(
    (error): LoginVerify => ({ ok: false, outcome: "inconclusive", detail: message(error) })
  );
  entry.verify = verify;
  entry.finalize = "done";
  await applyVerifyToRegistry(entry.accountName, verify);
}

/**
 * Reflect a verdict onto the account's needs-relogin flag. ONLY a provider
 * refusal flags re-login: a rate-limited or unreachable probe says nothing
 * about the credential, and flagging on those would park a perfectly good
 * account (and, for `auto`, remove it from rotation).
 */
export async function applyVerifyToRegistry(name: string, verify: LoginVerify): Promise<void> {
  if (verify.outcome === "rejected") {
    await setAccountNeedsRelogin(name, true).catch(() => undefined);
  } else if (
    verify.outcome === "verified" ||
    verify.outcome === "rate-limited" ||
    verify.outcome === "not-entitled"
  ) {
    // not-entitled included on purpose: the credential demonstrably
    // authenticated, so a stale needs-relogin flag would be a lie.
    await setAccountNeedsRelogin(name, false).catch(() => undefined);
  }
  // unverifiable / inconclusive: leave whatever flag the account already had.
  // Remember the verdict so the roster can keep showing WHY an account that is
  // perfectly logged in still cannot run - otherwise that answer is visible for
  // one dialog and then lost.
  if (verify.outcome !== "unverifiable" && verify.outcome !== "inconclusive") {
    await setAccountVerdict(name, {
      outcome: verify.outcome,
      detail: verify.detail,
      at: new Date().toISOString()
    }).catch(() => undefined);
  }
}

const VERIFY_TIMEOUT_MS = 15_000;

/**
 * Prove a freshly-captured token actually authenticates, per platform.
 *
 * Anthropic reuses the PAYMASTER's probe — a 1-token haiku-class call that
 * returns the unified rate-limit headers. That matters twice over: it costs
 * effectively nothing (the previous implementation ran a full `claude -p`
 * turn, which drags in the Claude Code system prompt and can itself push a
 * thin account over its 5h window), and a 429 comes back WITH headers, so
 * "your account is at its limit" is reported as such instead of as a failed
 * login. OpenAI/Google get a cheap authenticated GET; `custom` has no probe
 * Garrison could know about, and says so rather than claiming success.
 */
export async function verifyAccountToken(
  name: string,
  token: string,
  platform: AccountPlatform = "anthropic",
  fetchImpl: typeof fetch = fetch,
  credentialKind: CredentialKind = "token"
): Promise<LoginVerify> {
  // A subscription credential is verified by the CLI that owns it, under the
  // account's own config home - no API endpoint takes these tokens directly.
  if (credentialKind === "auth-file") return verifyAuthFileAccount(name, token, platform);
  if (platform === "anthropic") return verifyAnthropicToken(name, token, fetchImpl);
  if (platform === "custom") {
    return {
      ok: true,
      outcome: "unverifiable",
      detail:
        "Sealed in the vault. Garrison has no probe for a custom platform, so the token is stored unchecked - the first run under it is the real test."
    };
  }
  const targets: Record<string, { url: string; headers: Record<string, string>; label: string }> = {
    openai: {
      url: "https://api.openai.com/v1/models",
      headers: { authorization: `Bearer ${token}` },
      label: "OpenAI"
    },
    google: {
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      headers: { "x-goog-api-key": token },
      label: "Google"
    },
    openrouter: {
      url: "https://openrouter.ai/api/v1/credits",
      headers: { authorization: `Bearer ${token}` },
      label: "OpenRouter"
    },
    huggingface: {
      url: "https://huggingface.co/api/whoami-v2",
      headers: { authorization: `Bearer ${token}` },
      label: "Hugging Face"
    }
  };
  const target = targets[platform];
  if (!target) {
    return { ok: true, outcome: "unverifiable", detail: `no probe for ${platform}.` };
  }
  return probeHttpToken(target.url, target.headers, target.label, fetchImpl);
}

async function verifyAnthropicToken(
  name: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<LoginVerify> {
  try {
    const usage = await probeAccountUsage(name, token, fetchImpl);
    // The probe already cost a request — hand its numbers to the Paymaster so
    // the panel shows real usage immediately instead of "no usage data".
    await cacheUsage(name, usage).catch(() => undefined);
    const numbers = {
      fiveHourPct: usage.fiveHour.pct,
      weeklyPct: usage.weekly.pct,
      resetAt: usage.fiveHour.resetAt
    };
    const rejected =
      usage.status === "rejected" ||
      usage.fiveHour.status === "rejected" ||
      usage.weekly.status === "rejected" ||
      usage.fiveHour.pct >= 100 ||
      usage.weekly.pct >= 100;
    if (rejected) {
      return {
        ok: true,
        outcome: "rate-limited",
        detail:
          `Anthropic accepted the token - the login worked. This account is at its usage limit right now ` +
          `(5h ${usage.fiveHour.pct}%, weekly ${usage.weekly.pct}%), so runs under it are rejected until the window resets.`,
        usage: numbers
      };
    }
    return {
      ok: true,
      outcome: "verified",
      detail: `Anthropic accepted the token. Usage right now: 5h ${usage.fiveHour.pct}%, weekly ${usage.weekly.pct}%.`,
      usage: numbers
    };
  } catch (error) {
    if (error instanceof PaymasterProbeAuthError) {
      return {
        ok: false,
        outcome: "rejected",
        detail: "Anthropic refused the token (401/403) - it is not a valid credential. Run the login again."
      };
    }
    return {
      ok: false,
      outcome: "inconclusive",
      detail: `Could not reach Anthropic to check the token (${message(error)}). It is sealed in the vault regardless.`
    };
  }
}

/**
 * Verify a subscription credential by asking the platform's own CLI, with the
 * account's materialized home. Codex answers definitively and for free
 * (`codex login status`). Gemini has no status command, so the check is the
 * cheapest real call it offers; a version that cannot be reached is reported as
 * inconclusive rather than as a bad credential.
 */
async function verifyAuthFileAccount(
  name: string,
  content: string,
  platform: AccountPlatform
): Promise<LoginVerify> {
  const spec = PLATFORM_SPECS[platform].authFile;
  if (!spec) {
    return { ok: false, outcome: "rejected", detail: `${platform} has no subscription credential` };
  }
  let home: string;
  try {
    home = await materializeAccountHome(name, platform, content);
  } catch (error) {
    return { ok: false, outcome: "inconclusive", detail: `could not stage the credential: ${message(error)}` };
  }
  const env = { ...process.env, [spec.homeEnvKey]: home };
  if (platform === "openai") {
    const probe = await runCli("codex", ["login", "status"], env, 20_000);
    if (/logged in/i.test(probe.out)) {
      const via = probe.out.trim().split("\n").pop()?.trim() ?? "";
      return { ok: true, outcome: "verified", detail: `Codex accepted the credential - ${via}.` };
    }
    if (/not logged in/i.test(probe.out)) {
      return {
        ok: false,
        outcome: "rejected",
        detail: "Codex reports this credential as not logged in - it is expired or incomplete. Run the device login again."
      };
    }
    return {
      ok: false,
      outcome: "inconclusive",
      detail: `codex login status did not answer clearly (${probe.out.slice(0, 160).trim() || probe.error || "no output"}).`
    };
  }
  // Google: one cheap generation is the only honest liveness check the CLI has.
  // `--skip-trust` is REQUIRED, not optional: without it gemini refuses to run in
  // any directory it has not been told to trust ("not running in a trusted
  // directory"), which would fail the probe for a perfectly good credential.
  const probe = await runCli("gemini", ["--skip-trust", "-p", "ok"], env, 45_000);
  return classifyGeminiProbe(probe.code, probe.out || probe.error);
}

/**
 * Turn a `gemini -p` probe into a verdict. Pure, because the interesting cases
 * are all about telling apart failures that look alike in a terminal:
 * a bad credential, a good credential on a plan that does not cover the CLI,
 * and a probe that never got a real answer.
 */
export function classifyGeminiProbe(code: number | null, out: string): LoginVerify {
  const text = out ?? "";
  if (code === 0 && !/set an auth method|trusted directory/i.test(text)) {
    return { ok: true, outcome: "verified", detail: "Gemini answered under this credential." };
  }
  // Authenticated, but the Google account carries no Gemini Code Assist
  // entitlement (no AI Pro/Ultra, or a plan Google now requires you to migrate).
  // This is NOT a bad credential and logging in again cannot fix it, so it must
  // not read as a failed login - the same distinction the 429 case makes.
  if (/IneligibleTier|no longer supported|please migrate|not eligible/i.test(text)) {
    return {
      ok: false,
      outcome: "not-entitled",
      detail:
        "Google accepted the login, but this account has no Gemini Code Assist entitlement - " +
        "Gemini's CLI needs an active AI Pro/Ultra subscription (or a migrated plan). " +
        "Logging in again will not change it: either subscribe on this Google account, use a different one, " +
        "or add a Gemini API key account instead."
    };
  }
  if (/set an auth method|invalid_grant|invalid credentials|unauthenticated|token expired/i.test(text)) {
    return {
      ok: false,
      outcome: "rejected",
      detail: `Gemini refused the credential (${text.slice(0, 160).trim()}). Log in again on a machine with a browser and re-import.`
    };
  }
  return {
    ok: false,
    outcome: "inconclusive",
    detail: `Sealed in the vault, but the Gemini probe was not conclusive (${text.slice(0, 160).trim()}).`
  };
}

/** Run a CLI to completion, capturing merged output. Never throws. */
function runCli(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ code: number | null; out: string; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let error = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (out += chunk));
    const timer = setTimeout(() => {
      error = `${command} timed out after ${Math.round(timeoutMs / 1000)}s`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, error });
    });
    child.on("error", (spawnError: Error) => {
      clearTimeout(timer);
      resolve({ code: null, out, error: `${command} failed to start: ${spawnError.message}` });
    });
  });
}

/**
 * Adopt the box's OWN native login as a named, vaulted account. The crude path
 * that always works: no browser, no device code - the credential this machine
 * already holds becomes an account you can pin, keep, and switch away from.
 * Copy, never move: the box's own login is left exactly as it was.
 *
 * Limited to STATIC credentials (an API key sitting in the native file). A
 * rotating OAuth subscription login cannot be adopted this way and is refused -
 * see the error below for why "copy, never move" is not the harmless act it
 * reads as when the thing being copied rotates.
 */
export async function importNativeLogin(options: {
  name: string;
  platform: AccountPlatform;
  label?: string;
}): Promise<{ name: string; verify: LoginVerify }> {
  const spec = PLATFORM_SPECS[options.platform].authFile;
  if (!spec || (options.platform !== "openai" && options.platform !== "google")) {
    throw new Error(`${options.platform} has no importable native credential file`);
  }
  const file = nativeCredentialPath(options.platform);
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(
      `this box has no ${spec.label} to import (${file} is absent) - run \`${spec.loginHint}\` on the host first`
    );
  }
  const parsed = parseAuthFile(options.platform, content);
  if (!parsed.ok) throw new Error(`${file}: ${parsed.error}`);
  // The refusal that keeps this box logged in. An imported OAuth login is not a
  // second account - it is a second HOLDER of one rotating refresh token, and
  // the first refresh on either side revokes the other (the provider reads the
  // superseded token as replay and kills the family). Garrison shipped this
  // import on 2026-07-25 and it logged the host out of Codex repeatedly until
  // 2026-08-16. There are two honest ways to get the same outcome, and the
  // message names both rather than leaving the user to guess.
  if (isRotatingCredential(parsed.value)) {
    throw new Error(
      `${file} is a rotating ${spec.label} login, which cannot be adopted as an account: the account home and ` +
        `${file} would hold the same refresh token, and the first side to refresh revokes the other - logging ` +
        `this box out. To RUN as this box's login, leave the runtime's account on "Machine login" (that is what ` +
        `it means and it needs no account). To run as a SEPARATE identity, use Device login, which mints that ` +
        `account its own credential.`
    );
  }
  const meta = await addAccount({
    name: options.name,
    token: content,
    label: options.label,
    platform: options.platform,
    credential_kind: "auth-file"
  });
  const verify = await verifyAccountToken(meta.name, content, options.platform, fetch, "auth-file");
  await applyVerifyToRegistry(meta.name, verify);
  // Name it after whoever it turns out to be. The credential we just stored may
  // already say (Codex's auth.json carries an id_token with an email claim), and
  // learning it here means the roster is right on the FIRST render rather than
  // after a backfill pass. Best-effort: an account with no free identity keeps
  // the name the user gave it.
  const identity = await identityFromCredential(meta.name, options.platform).catch(() => null);
  if (identity) await setAccountIdentity(meta.name, identity);
  return { name: meta.name, verify };
}

/** A cheap authenticated GET — 2xx proves the key, 401/403 disproves it. */
async function probeHttpToken(
  url: string,
  headers: Record<string, string>,
  label: string,
  fetchImpl: typeof fetch
): Promise<LoginVerify> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (response.ok) {
      return { ok: true, outcome: "verified", detail: `${label} accepted the key.` };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        outcome: "rejected",
        detail: `${label} refused the key (${response.status}) - check that it was pasted whole and is still active.`
      };
    }
    if (response.status === 429) {
      return {
        ok: true,
        outcome: "rate-limited",
        detail: `${label} accepted the key but is rate-limiting it right now (429). The key itself is fine.`
      };
    }
    return {
      ok: false,
      outcome: "inconclusive",
      detail: `${label} answered ${response.status} - the key is sealed in the vault but could not be confirmed.`
    };
  } catch (error) {
    return {
      ok: false,
      outcome: "inconclusive",
      detail: `Could not reach ${label} to check the key (${message(error)}). It is sealed in the vault regardless.`
    };
  } finally {
    clearTimeout(timer);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loginStatus(id: string): Promise<LoginStatus | null> {
  if (!ID_RE.test(id)) return null;
  const entry = runtime().sessions.get(id);
  const helper = await readHelperStatus(id);
  if (!entry && !helper) return null;
  const fallback: LoginRuntimeEntry = entry ?? { accountName: "", mode: "setup-token" };

  // Finalize lazily on poll: the helper marks "captured"; the server moves the
  // token into the vault + verifies on the next status read.
  if (helper?.state === "captured" && fallback.accountName) {
    await finalizeCapture(id, fallback);
  }

  const helperState = String(helper?.state ?? "starting") as LoginStatus["state"];
  let state: LoginStatus["state"] = helperState;
  let error = (helper?.error as string | null) ?? null;
  if (fallback.finalize === "pending" || fallback.finalize === "verifying") state = "verifying";
  if (fallback.finalize === "done") state = "done";
  if (fallback.finalize === "failed") {
    state = "error";
    error = fallback.finalizeError ?? "storing the captured token failed";
  }

  return {
    id,
    accountName: fallback.accountName,
    mode: fallback.mode,
    userCode: (helper?.userCode as string | null) ?? null,
    state,
    authorizeUrl: (helper?.authorizeUrl as string | null) ?? null,
    outputTail: String(helper?.outputTail ?? ""),
    error,
    verify: fallback.verify ?? null
  };
}

export async function sendLoginInput(id: string, text: string): Promise<void> {
  if (!ID_RE.test(id)) throw new Error("unknown login id");
  // One line only — the input is typed into a PTY.
  const line = text.replace(/[\r\n]+/g, " ").trim().slice(0, 4096);
  await fs.writeFile(path.join(loginDir(id), "input.txt"), line, { mode: 0o600 });
}

export async function cancelLogin(id: string): Promise<void> {
  if (!ID_RE.test(id)) throw new Error("unknown login id");
  await fs.writeFile(path.join(loginDir(id), "cancel"), "");
}
