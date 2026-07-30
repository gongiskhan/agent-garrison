// ask_gary chat tool (spec M5): Omi's chat UI answers with Garrison's
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
import { secretMatches } from "./ingress.mjs";

// Target is "under 10 seconds wall time" - abort with headroom for the
// notification round-trip and Omi's own overhead.
export const ASK_DEADLINE_MS = Number(process.env.OMI_CHAT_DEADLINE_MS) || 8500;

const BUSY_ANSWER =
  "Gary couldn't finish thinking in time - he may be mid-task. Ask again in a moment.";
const OFFLINE_ANSWER = "Gary is offline right now (his gateway is not running). Try again later.";

export function buildManifest(cfg) {
  const key = cfg.secrets.webhookSecret ?? "";
  const base = cfg.publicBaseUrl || "";
  // Absolute when the public base is configured (the Funnel address the human
  // typed into the Omi app), else relative for App-Home-URL resolution.
  const endpoint = `${base}/omi/chat?key=${encodeURIComponent(key)}`;
  return {
    tools: [
      {
        name: "ask_gary",
        description:
          "Ask Gary - the user's personal AI chief of staff - anything about the user's tasks, projects, Kanban board, schedule, plans, memories, notes, past conversations, or decisions, and any question that requires reasoning over the user's personal or work context. Use this whenever the user addresses Gary directly or asks about their own work, agenda, or saved information.",
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
        status_message: "Asking Gary..."
      }
    ]
  };
}

export function buildAskPrompt(query) {
  return `The user is asking you this through their wearable's chat (ask_gary). Answer directly from what you already know - your memories, the Kanban board state, today's context. Be concise (under 120 words), plain text, no markdown, no preamble. If you genuinely don't know, say so in one sentence. Keep the user's language (Portuguese stays Portuguese).

Question: ${query}`;
}

export class ChatTool {
  constructor({ cfg, store, counters, runFn, deadlineMs = ASK_DEADLINE_MS, log = console }) {
    this.cfg = cfg;
    this.store = store;
    this.counters = counters;
    this.runFn = runFn;
    this.deadlineMs = deadlineMs;
    this.log = log;
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
      this.log.error(`[omi-channel] ask_gary failed: ${err?.message ?? err}`);
      return { status: 200, body: { result: BUSY_ANSWER } };
    }
    const elapsed = Date.now() - startedAt;
    this.counters.observe("chat_answer_ms", elapsed);

    if (outcome?.overrun) {
      this.counters.bump("chat_overruns");
      return { status: 200, body: { result: BUSY_ANSWER } };
    }
    const reply = String(outcome?.reply ?? "").trim();
    if (!reply) {
      this.counters.bump("chat_empty");
      return { status: 200, body: { result: "Gary had no answer for that." } };
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
