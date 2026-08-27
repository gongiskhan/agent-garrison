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

/**
 * Re-attach the output items the Codex backend leaves out of `response.completed`.
 *
 * Its stream is a correct Responses SSE in every respect but one: the terminal
 * `response.completed` event carries `output: []` even after it has streamed the
 * assembled item in `response.output_item.done`. The SDK builds its final result
 * from that array, so the run yields NO output, the agent loop sees an empty turn
 * and keeps going until it hits max_turns - while the model in fact answered on
 * the first pass. (The Codex CLI does not notice because it renders the deltas.)
 *
 * So: remember every completed item, and if the terminal event's output is empty,
 * fill it with them. Nothing is invented - these are the backend's own assembled
 * items, moved to where the contract says they belong. An event that does not
 * parse, or a completed event that DOES carry output, passes through untouched.
 */
export function repairCompletedOutput(body) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const items = [];
  let buffered = "";

  const patch = (raw) => {
    const line = raw.split("\n").find((l) => l.startsWith("data: "));
    if (!line) return raw;
    let payload;
    try {
      payload = JSON.parse(line.slice(6));
    } catch {
      return raw;
    }
    if (payload?.type === "response.output_item.done" && payload.item) {
      items.push(payload.item);
      return raw;
    }
    if (
      payload?.type === "response.completed" &&
      Array.isArray(payload.response?.output) &&
      payload.response.output.length === 0 &&
      items.length
    ) {
      payload.response.output = items;
      return raw.replace(line, `data: ${JSON.stringify(payload)}`);
    }
    return raw;
  };

  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true });
        // SSE events are separated by a blank line; an event can straddle chunks,
        // so only complete ones are emitted and the remainder is carried forward.
        let split;
        while ((split = buffered.indexOf("\n\n")) !== -1) {
          const raw = buffered.slice(0, split + 2);
          buffered = buffered.slice(split + 2);
          controller.enqueue(encoder.encode(patch(raw)));
        }
      },
      flush(controller) {
        if (buffered) controller.enqueue(encoder.encode(patch(buffered)));
      }
    })
  );
}

export function createChatGptFetch(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const resolve = opts.resolve ?? resolveChatGptCredential;
  const sessionId = opts.sessionId ?? randomUUID();
  const env = opts.env ?? process.env;

  // Was THIS request a streamed /responses call? Needed to repair the response
  // (see the content-type note below), and knowable only from the outbound body.
  let lastWasStream = false;

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
        const parsed = normalizeResponsesBody(JSON.parse(body));
        lastWasStream = parsed.stream === true;
        body = JSON.stringify(parsed);
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
    // The backend answers a streamed /responses call with a correct SSE body and NO
    // content-type header at all. The OpenAI client decides whether to PARSE a
    // response as a stream from that header, so without it the events are never
    // read: the agent loop sees no output, produces nothing, and runs to max_turns
    // while the model answered perfectly. Label the response for what it demonstrably
    // is. Only when we asked for a stream, only when the header is genuinely absent -
    // never overriding one the server sent.
    // Two repairs to a streamed response, both for things the backend omits:
    //  1. no content-type header at all - the OpenAI client decides whether to PARSE
    //     a response as a stream from it, so without one the events are never read.
    //  2. an empty `output` on the terminal event (see repairCompletedOutput).
    // Neither overrides anything the server actually sent.
    if (res.ok && lastWasStream && res.body) {
      const headers = new Headers(res.headers);
      if (!headers.get("content-type")) headers.set("content-type", "text/event-stream");
      return new Response(repairCompletedOutput(res.body), {
        status: res.status,
        statusText: res.statusText,
        headers
      });
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
