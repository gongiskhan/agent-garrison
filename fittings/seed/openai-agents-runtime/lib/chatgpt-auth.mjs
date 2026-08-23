// chatgpt-auth.mjs - the ChatGPT-subscription credential for the Codex backend.
//
// The `chatgpt-subscription` provider does not authenticate with an API key. It
// carries the SAME OAuth credential the Codex CLI mints (`codex login`) and that
// Garrison's Accounts area already seals per account: an `auth.json` holding an
// access token, a rotating refresh token, and the workspace's account id.
//
// WHY THIS MODULE EXISTS AT ALL. Every other provider in this fitting resolves a
// static string from the vault, so `resolveEndpoint` can be pure. A subscription
// credential is not static: the access token expires, and refreshing it ROTATES
// the refresh token, so the refreshed file must be written back or the next
// process starts from a token OpenAI has already invalidated. That is real I/O
// with a real failure mode, so it lives here rather than polluting providers.mjs.
//
// SINGLE-FLIGHT, AND WHY IT MATTERS MORE THAN USUAL. A rotating refresh token is
// single-use. Two concurrent turns that both decide to refresh would race, and
// the loser would persist a token the server already replaced - a self-inflicted
// logout. The in-process promise cache below collapses concurrent refreshes into
// one. It cannot coordinate across PROCESSES, which is exactly why an account's
// auth file must be owned by one config home (see accounts.ts's per-account home)
// rather than shared with the box's own ~/.codex.

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Codex's public OAuth client id (the one `codex login` uses). */
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

/** Refresh this long before the token actually expires. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** The claim the account id hides in when `tokens.account_id` is absent. */
const AUTH_CLAIM = "https://api.openai.com/auth";

/** In-flight refreshes, keyed by auth-file path (see single-flight note above). */
const inflight = new Map();

/**
 * Where this launch's subscription credential lives.
 *
 * `CODEX_HOME` is not a Codex-CLI detail leaking in: it is the env var Garrison's
 * account layer ALREADY sets to point a spawn at one account's config home
 * (accountHomeDir + PLATFORM_SPECS.openai.authFile.homeEnvKey). Reading it here is
 * what makes "pick account X in the composer" work for this runtime for free -
 * the same pin that switches Codex switches this.
 */
export function authFilePath(env = process.env) {
  const explicit = env.GARRISON_CHATGPT_AUTH_FILE;
  if (explicit) return explicit;
  const home = env.CODEX_HOME;
  if (home) return path.join(home, "auth.json");
  return path.join(env.HOME || os.homedir(), ".codex", "auth.json");
}

/** Decode a JWT payload without verifying it (we only read `exp` and claims). */
function jwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** Expiry of an access token in epoch ms, or 0 when it cannot be read. */
function expiryMs(accessToken) {
  const exp = jwtPayload(accessToken)?.exp;
  return typeof exp === "number" ? exp * 1000 : 0;
}

/**
 * The workspace this credential bills to. `tokens.account_id` is authoritative;
 * the id_token claim is the documented fallback; empty means "the account's
 * default workspace", which the backend accepts.
 */
export function accountIdOf(tokens = {}) {
  if (tokens.account_id) return String(tokens.account_id);
  const claim = jwtPayload(tokens.id_token)?.[AUTH_CLAIM];
  return String(claim?.chatgpt_account_id ?? "");
}

export class ChatGptAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ChatGptAuthError";
    this.code = code || "chatgpt-auth";
  }
}

async function readAuthFile(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    throw new ChatGptAuthError(
      `no ChatGPT subscription credential at ${file} - sign in from the Accounts page (or run \`codex login\`) and pick that account on this runtime`,
      "credential-absent"
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ChatGptAuthError(`ChatGPT credential at ${file} is not valid JSON`, "credential-corrupt");
  }
  const tokens = parsed?.tokens ?? {};
  if (!tokens.access_token && !tokens.refresh_token) {
    throw new ChatGptAuthError(
      `ChatGPT credential at ${file} carries no tokens - it is an API-key login, not a subscription. Use provider \`openai\` with a key, or sign in with ChatGPT.`,
      "credential-not-subscription"
    );
  }
  return { parsed, tokens };
}

/** Exchange the rotating refresh token for a fresh access token. */
async function refreshTokens(refreshToken) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email"
    })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ChatGptAuthError(
      `ChatGPT token refresh failed (${res.status}): ${text.slice(0, 300)} - sign in again from the Accounts page`,
      "refresh-failed"
    );
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ChatGptAuthError("ChatGPT token refresh returned a non-JSON body", "refresh-failed");
  }
  if (!body.access_token) {
    throw new ChatGptAuthError("ChatGPT token refresh returned no access_token", "refresh-failed");
  }
  return body;
}

/**
 * Persist a refreshed credential. Written to a sibling temp file and renamed, at
 * mode 0600: a half-written auth.json is an unrecoverable logout, and rename is
 * the only way to make the replacement atomic. The ORIGINAL object is spread
 * through so fields this module does not model (auth_mode, and whatever a future
 * CLI version adds) survive the round trip untouched.
 */
async function persist(file, parsed, tokens) {
  const next = {
    ...parsed,
    tokens: { ...parsed.tokens, ...tokens },
    last_refresh: new Date().toISOString()
  };
  const tmp = `${file}.garrison-${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, file);
  return next;
}

/**
 * Resolve a usable {accessToken, accountId, file} for this launch, refreshing
 * and persisting when the token is expired or about to be.
 *
 * @param opts.env       env to resolve the auth file from (default process.env)
 * @param opts.now       clock injection for tests
 * @param opts.forceRefresh  refresh even if the token still looks valid (used
 *   once after a 401, so a revoked-but-unexpired token self-heals)
 */
export function resolveChatGptCredential(opts = {}) {
  const file = opts.file ?? authFilePath(opts.env ?? process.env);
  const key = `${file}::${opts.forceRefresh ? "force" : "normal"}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const { parsed, tokens } = await readAuthFile(file);
    const now = opts.now ?? Date.now();
    const stale = !tokens.access_token || expiryMs(tokens.access_token) - now < REFRESH_SKEW_MS;
    if (!stale && !opts.forceRefresh) {
      return { accessToken: tokens.access_token, accountId: accountIdOf(tokens), file, refreshed: false };
    }
    if (!tokens.refresh_token) {
      throw new ChatGptAuthError(
        `ChatGPT access token at ${file} is expired and there is no refresh token - sign in again from the Accounts page`,
        "credential-expired"
      );
    }
    const fresh = await refreshTokens(tokens.refresh_token);
    // Keep whatever the server did not rotate (it may omit refresh_token/id_token).
    const merged = {
      access_token: fresh.access_token,
      ...(fresh.refresh_token ? { refresh_token: fresh.refresh_token } : {}),
      ...(fresh.id_token ? { id_token: fresh.id_token } : {})
    };
    const next = await persist(file, parsed, merged);
    return {
      accessToken: next.tokens.access_token,
      accountId: accountIdOf(next.tokens),
      file,
      refreshed: true
    };
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Test seam: drop any cached in-flight refresh. */
export function resetChatGptAuthCache() {
  inflight.clear();
}
