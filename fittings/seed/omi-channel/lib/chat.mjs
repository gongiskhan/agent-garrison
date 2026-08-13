// ask_zeca chat tool (spec M5): Omi's chat UI answers with Garrison's
// orchestrator on a bounded fast path. One tool, one param ({query}), plain
// text back, under a hard wall-time budget - overruns abort into a friendly
// partial answer rather than an Omi-side timeout.
//
// Auth (I8): Omi sends NO credential on tool calls (verified docs), so the
// manifest embeds our shared secret in the endpoint URL (?key=), and the
// handler additionally checks app_id against the sealed OMI_APP_ID and the
// uid against the pin. auth_required is false in the manifest - there is no
// per-user OAuth here, the wearer IS the single pinned user.

import crypto from "node:crypto";
import path from "node:path";
import { secretMatches } from "./ingress.mjs";
import { atomicWriteJSON, ulid } from "./store.mjs";

// Target is "under 10 seconds wall time" - abort with headroom for the
// notification round-trip and Omi's own overhead.
export const ASK_DEADLINE_MS = Number(process.env.OMI_CHAT_DEADLINE_MS) || 8500;

const BUSY_ANSWER =
  "Zeca couldn't finish thinking in time - he may be mid-task. Ask again in a moment.";
// Said when the question has been handed to the operative: the wearer must know
// an answer is still coming, or they will re-ask and queue the work twice.
const WORKING_ANSWER = "Looking into that now - I'll message you the answer in a moment.";
const OFFLINE_ANSWER = "Zeca is offline right now (his gateway is not running). Try again later.";

export function buildManifest(cfg) {
  const key = cfg.secrets.webhookSecret ?? "";
  const base = cfg.publicBaseUrl || "";
  // Absolute when the public base is configured (the Funnel address the human
  // typed into the Omi app), else relative for App-Home-URL resolution.
  const endpoint = `${base}/omi/chat?key=${encodeURIComponent(key)}`;
  return {
    tools: [
      {
        name: "ask_zeca",
        description:
          "Ask Zeca - the user's personal AI chief of staff - anything about the user's tasks, projects, Kanban board, schedule, plans, memories, notes, past conversations, or decisions, and any question that requires reasoning over the user's personal or work context. Use this whenever the user addresses Zeca directly or asks about their own work, agenda, or saved information.",
        endpoint,
        method: "POST",
        parameters: {
          properties: {
            query: {
              type: "string",
              description: "The user's question, as close to verbatim as possible."
            }
          },
          required: ["query"]
        },
        auth_required: false,
        status_message: "Asking Zeca..."
      }
    ],
    // Lets the app post into the user's chat (docs: ChatTools "Proactive chat
    // messages"). Without this block at the manifest ROOT the chat-message API
    // rejects every call, and a push notification's tap target - the chat - stays
    // empty, which is exactly the "I got a buzz I cannot read" failure.
    // target "main" so answers land in the chat the notification opens, and
    // notify false because the push is sent separately and would otherwise double.
    chat_messages: {
      enabled: true,
      target: "main",
      notify: false
    }
  };
}

// The fast attempt. This runs on the small pinned classifier lane, so it has no
// tools and no view of the user's data - it must therefore be allowed to DECLINE
// rather than guess, which is what the sentinel is for. A confident invention
// about the user's own board or calendar is the worst possible answer here.
export const NEEDS_ZECA = "NEEDS_ZECA";

export function buildAskPrompt(query) {
  return `The user asked this through their wearable's chat. You are a small, fast model with NO tools: you cannot see their Kanban board, calendar, files, memories, messages or past conversations, and you cannot search the web or contact any service.

Question: ${query}

If answering correctly requires ANY of the things you cannot see, or requires doing something, reply with exactly ${NEEDS_ZECA} and nothing else. Only answer directly when general knowledge is genuinely enough. When you do answer: under 120 words, plain text, no markdown, no preamble. Keep the user's language (Portuguese stays Portuguese).`;
}

// What the OPERATIVE sees for a question escalated out of Omi chat.
export function buildAskDelegatePrompt(query) {
  return `The user asked this in their wearable's chat: "${query}"

Answer it properly using your tools and connected services - their Kanban board, memories, files, calendar and anything else you can reach. If they are asking you to do something, do it. If something is genuinely unavailable (no access, missing credential, service not connected), say exactly what is missing in one sentence rather than guessing.

Reply in under 80 words, plain text, no markdown, no preamble. This is delivered to their phone as a notification. Keep the user's language (Portuguese stays Portuguese).`;
}

export class ChatTool {
  constructor({
    cfg,
    store,
    counters,
    runFn,
    operativeFn = null,
    notifier = null,
    deadlineMs = ASK_DEADLINE_MS,
    log = console
  }) {
    this.cfg = cfg;
    this.store = store;
    this.counters = counters;
    this.runFn = runFn;
    // Escalation lane + the surface the escalated answer comes back on. Without
    // both, a question needing tools can only ever time out: Omi holds a tool
    // call open for seconds, the operative's turn takes tens of seconds to
    // minutes, and no amount of budget tuning closes that gap.
    this.operativeFn = operativeFn;
    this.notifier = notifier;
    this.deadlineMs = deadlineMs;
    this.log = log;
    this.delegateChain = Promise.resolve();
  }

  // Hand the question to the operative and push the answer to the wearer when
  // it lands. Never rejects: the user was already promised a follow-up.
  escalate(question) {
    this.counters.bump("chat_delegates");
    this.delegateChain = this.delegateChain
      .then(async () => {
        const startedAt = Date.now();
        let text = "";
        try {
          const { reply } = await this.operativeFn({
            prompt: buildAskDelegatePrompt(question),
            sessionTitle: "Omi chat question"
          });
          text = String(reply ?? "").trim();
        } catch (err) {
          this.log.error(`[omi-channel] ask_zeca delegate failed: ${err?.message ?? err}`);
          text = "I couldn't finish that one - try asking again.";
        }
        if (!text) text = "I looked, but had nothing to report back.";
        const elapsedMs = Date.now() - startedAt;
        this.counters.observe("chat_delegate_ms", elapsedMs);
        this.counters.bump("chat_delegates_answered");
        // The answer leaves over a notification and is gone. Keeping the pair
        // on disk is what makes "Zeca answered nonsense" a diagnosable claim
        // rather than a memory of a phone screen - the wake path already does
        // this for its delegated requests.
        atomicWriteJSON(path.join(this.store.root, "chat-results", `${ulid()}.json`), {
          question,
          reply: text,
          elapsedMs,
          at: new Date().toISOString()
        });
        await this.notifier
          .send({ template: "wake_confirmation", params: { text: text.slice(0, 800) } })
          .catch(() => []);
      })
      .catch((err) => this.log.error(`[omi-channel] ask_zeca delegate chain error: ${err?.message ?? err}`));
  }

  // -> { ok: true, uid } | { ok: false, status, error }  (error text is
  // user-facing per the ChatTools docs - actionable, never internals)
  authorize(query, body) {
    if (!this.cfg.chatEnabled) {
      this.counters.bump("chat_rejected_disabled");
      return { ok: false, status: 403, error: "This tool is currently disabled." };
    }
    const expected = this.cfg.secrets.webhookSecret;
    if (!expected || !secretMatches(query?.key, expected)) {
      this.counters.bump("chat_rejected_auth");
      // Lengths only, never the secret - the ingress routes log rejects the
      // same way, and a silent chat 401 already cost a day of "Zeca is broken"
      // (Omi caches the tools manifest, so a stale cached key 401s forever
      // until the app is re-saved).
      const presented = typeof query?.key === "string" ? query.key : "";
      this.log.warn?.(
        `[omi-channel] chat rejected bad key: presented len=${presented.length}; expected len=${expected ? expected.length : 0}`
      );
      return { ok: false, status: 401, error: "Unauthorized." };
    }
    const appId = this.cfg.secrets.appId;
    if (appId && body?.app_id && body.app_id !== appId) {
      this.counters.bump("chat_rejected_app");
      return { ok: false, status: 401, error: "Unknown app." };
    }
    const uid = typeof body?.uid === "string" ? body.uid.trim() : "";
    if (!uid) {
      this.counters.bump("chat_rejected_no_uid");
      return { ok: false, status: 400, error: "Missing uid." };
    }
    const pinned = this.store.pinnedUid() ?? this.store.pinUid(uid);
    if (uid !== pinned) {
      this.counters.bump("chat_rejected_uid");
      return { ok: false, status: 403, error: "This assistant is not available for your account." };
    }
    return { ok: true, uid };
  }

  // -> { status, body } per the ChatTools response contract: 200 {result} or
  // {error}. The overrun path is a 200 with a friendly partial answer.
  async handle(query, body) {
    const verdict = this.authorize(query, body);
    if (!verdict.ok) return { status: verdict.status, body: { error: verdict.error } };

    const question = typeof body?.query === "string" ? body.query.trim() : "";
    if (!question) return { status: 400, body: { error: "Ask a question in the query parameter." } };

    this.counters.bump("chat_calls");
    if (!this.runFn) {
      this.counters.bump("chat_offline");
      return { status: 200, body: { result: OFFLINE_ANSWER } };
    }

    const startedAt = Date.now();
    const deadline = new Promise((resolve) =>
      setTimeout(() => resolve({ overrun: true }), this.deadlineMs).unref?.()
    );
    let outcome = null;
    try {
      outcome = await Promise.race([
        this.runFn({ prompt: buildAskPrompt(question) }).then((r) => ({ reply: r?.reply ?? "" })),
        deadline
      ]);
    } catch (err) {
      this.counters.bump("chat_failed");
      this.log.error(`[omi-channel] ask_zeca failed: ${err?.message ?? err}`);
      return { status: 200, body: { result: BUSY_ANSWER } };
    }
    const elapsed = Date.now() - startedAt;
    this.counters.observe("chat_answer_ms", elapsed);

    const canEscalate = Boolean(this.cfg.delegateEnabled && this.operativeFn && this.notifier);

    // Overrun and refusal are the same situation from the user's side: the fast
    // lane cannot answer this one. Both escalate rather than dead-ending, which
    // is the whole point - the previous behaviour returned "ask again in a
    // moment" and threw the question away, so asking again just repeated it.
    if (outcome?.overrun) {
      this.counters.bump("chat_overruns");
      if (canEscalate) {
        this.escalate(question);
        return { status: 200, body: { result: WORKING_ANSWER } };
      }
      return { status: 200, body: { result: BUSY_ANSWER } };
    }
    const reply = String(outcome?.reply ?? "").trim();
    // The sentinel may arrive alone or wrapped in a sentence; either way the
    // fast lane is telling us it had to guess, so treat it as a refusal.
    if (reply.includes(NEEDS_ZECA)) {
      this.counters.bump("chat_needs_operative");
      if (canEscalate) {
        this.escalate(question);
        return { status: 200, body: { result: WORKING_ANSWER } };
      }
      return { status: 200, body: { result: OFFLINE_ANSWER } };
    }
    if (!reply) {
      this.counters.bump("chat_empty");
      if (canEscalate) {
        this.escalate(question);
        return { status: 200, body: { result: WORKING_ANSWER } };
      }
      return { status: 200, body: { result: "Zeca had no answer for that." } };
    }
    this.counters.bump("chat_answered");
    return { status: 200, body: { result: reply.slice(0, 2000) } };
  }

  manifest(query) {
    if (!this.cfg.chatEnabled) return { status: 403, body: { error: "This tool is currently disabled." } };
    const expected = this.cfg.secrets.webhookSecret;
    if (!expected || !secretMatches(query?.key, expected)) {
      this.counters.bump("chat_rejected_auth");
      return { status: 401, body: { error: "Unauthorized." } };
    }
    return { status: 200, body: buildManifest(this.cfg) };
  }
}

// Deterministic fingerprint used by tests to assert manifest stability.
export function manifestFingerprint(cfg) {
  return crypto.createHash("sha256").update(JSON.stringify(buildManifest(cfg))).digest("hex").slice(0, 16);
}
