// chatgpt-transport.mjs - the fetch the OpenAI client uses for the ChatGPT
// subscription provider.
//
// The Codex backend speaks the Responses API, but it is NOT the platform API and
// it has three demands the SDK does not make on its own. Rather than fork the
// SDK's request builder, this wraps `fetch` and normalises the outbound body -
// the same shape the Go and Rust clients use, and the smallest surface that can
// drift when the SDK changes:
//
//   store: false                          - the backend refuses a stored response
//   instructions: non-empty               - it rejects an absent/empty instruction
//   include: reasoning.encrypted_content   - required to carry reasoning across turns
//
// It also stamps the per-connection identity headers. `originator` is load-bearing
// and worth being explicit about: the backend routes newer models (the gpt-5.6
// family) only for recognised originators, so a bespoke value gets "Model not
// found" on exactly the models this composition is built to use. We send the
// Codex CLI's value because that is the client this credential is issued for.
//
// The auth token is resolved PER REQUEST (not captured once) so a long-lived
// gateway process keeps working across an access-token expiry, and a 401 triggers
// one forced refresh + retry so a revoked-but-unexpired token self-heals instead
// of failing every turn until restart.

import { randomUUID } from "node:crypto";
import { resolveChatGptCredential, ChatGptAuthError } from "./chatgpt-auth.mjs";

/** Identity of the client this credential is issued for. */
export const CHATGPT_ORIGINATOR = "codex_cli_rs";

/** Required by the backend to carry reasoning between turns of one run. */
const REQUIRED_INCLUDE = "reasoning.encrypted_content";

/** The backend rejects an empty instruction; this is the floor, not a prompt. */
const INSTRUCTIONS_FLOOR = "You are a helpful coding assistant.";

export class ChatGptUsageLimitError extends Error {
  constructor(detail) {
    const resets = detail?.resets_at ? new Date(detail.resets_at * 1000).toISOString() : null;
    super(
      `ChatGPT subscription usage limit reached${detail?.plan_type ? ` (plan ${detail.plan_type})` : ""}` +
        `${resets ? ` - resets at ${resets}` : ""}. Route to another account or wait for the reset.`
    );
    this.name = "ChatGptUsageLimitError";
    this.code = "usage-limit-reached";
    this.resetsAt = detail?.resets_at ?? null;
    this.planType = detail?.plan_type ?? null;
  }
}

/** Rewrite one outbound Responses body into the shape the backend accepts. */
export function normalizeResponsesBody(body) {
  if (!body || typeof body !== "object") return body;
  const next = { ...body, store: false };
  if (typeof next.instructions !== "string" || !next.instructions.trim()) {
    next.instructions = INSTRUCTIONS_FLOOR;
  }
  const include = Array.isArray(next.include) ? next.include.slice() : [];
  if (!include.includes(REQUIRED_INCLUDE)) include.push(REQUIRED_INCLUDE);
  next.include = include;
  return next;
}

function isResponsesCall(url) {
  return String(url).includes("/responses");
}

/**
 * Build the `fetch` implementation for a subscription-backed OpenAI client.
 *
 * @param opts.env         env the auth file is resolved from
 * @param opts.sessionId   stable id for this run (the backend logs it per session)
 * @param opts.fetchImpl   injection seam for tests
 * @param opts.resolve     injection seam for the credential resolver
 */
export function createChatGptFetch(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const resolve = opts.resolve ?? resolveChatGptCredential;
  const sessionId = opts.sessionId ?? randomUUID();
  const env = opts.env ?? process.env;

  const send = async (url, init, forceRefresh) => {
    const cred = await resolve({ env, forceRefresh });
    const headers = new Headers(init?.headers ?? {});
    headers.set("authorization", `Bearer ${cred.accessToken}`);
    if (cred.accountId) headers.set("chatgpt-account-id", cred.accountId);
    headers.set("originator", CHATGPT_ORIGINATOR);
    headers.set("session_id", sessionId);
    if (!headers.has("openai-beta")) headers.set("openai-beta", "responses=experimental");

    let body = init?.body;
    if (isResponsesCall(url) && typeof body === "string") {
      try {
        body = JSON.stringify(normalizeResponsesBody(JSON.parse(body)));
      } catch {
        // A body we cannot parse is passed through untouched rather than dropped -
        // the backend's own error is more useful than one invented here.
      }
    }
    return fetchImpl(url, { ...init, headers, body });
  };

  return async (url, init = {}) => {
    let res = await send(url, init, false);
    // 401 on a token that had not expired means it was revoked or rotated out from
    // under us (a parallel `codex login`, another home refreshing the same account).
    // One forced refresh recovers it; a second 401 is a real auth failure.
    if (res.status === 401) {
      res = await send(url, init, true);
    }
    if (res.status === 429) {
      // Read the body to classify: a plan limit is a routing fact the operator can
      // act on, and it must not be reported as a generic rate limit the SDK retries.
      const text = await res.clone().text();
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error?.type === "usage_limit_reached") throw new ChatGptUsageLimitError(parsed.error);
      } catch (err) {
        if (err instanceof ChatGptUsageLimitError) throw err;
      }
    }
    return res;
  };
}

export { ChatGptAuthError };
