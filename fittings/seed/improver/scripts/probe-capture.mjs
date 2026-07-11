#!/usr/bin/env node
// probe-capture.mjs — the Improver Probe's answer capture (GARRISON-FLOW-V2 S8,
// D26). Registered as a PostToolUse hook matching AskUserQuestion (E12 CONFIRMED:
// the selected label rides in tool_response.answers as {question: label}).
//
// On each AskUserQuestion completion we:
//   • load the pending probe for THIS session (session_id match);
//   • match answered vs unanswered pending questions against the answers map
//     (exact question-text key, with a single-question rephrase fallback);
//   • if NONE of our pending questions were answered, this is an unrelated
//     AskUserQuestion the operative issued on its own — leave the pending for the
//     Stop-hook sweeper and exit (we never capture the operative's own questions);
//   • otherwise append ONE D26 record per answered question (provenance probe or
//     retrospective) and ONE dismissed record per unanswered question, then clear
//     the pending. Atomic single-write appends into the shared feedback queue.
//
// Fail-safe: any error exits 0 (a missed capture is recovered by the sweeper's
// dismissed record; a thrown hook would surface noise to the operative).

import { readFileSync } from "node:fs";
import { matchAnswers, buildFeedbackRecord } from "../lib/probe-core.mjs";
import * as store from "../lib/probe-store.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const now = process.env.PROBE_NOW || new Date().toISOString();
  let payload = {};
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return 0;
  }
  const sessionId = payload.session_id || payload.sessionId || null;
  // E12: tool_response.answers is load-bearing; tool_input.answers mirrors it.
  const answers = payload.tool_response?.answers || payload.tool_input?.answers || null;
  if (!answers || typeof answers !== "object") return 0;

  // Per-session pending (F1): read THIS session's file directly. A capture with no
  // session_id cannot key a pending, so it no-ops.
  if (!sessionId) return 0;
  const pending = store.readPending(sessionId);
  if (!pending || !Array.isArray(pending.questions) || !pending.questions.length) return 0;

  const { answered, unanswered } = matchAnswers(pending, answers);
  if (!answered.length) return 0; // unrelated AskUserQuestion — leave pending for the sweeper

  const provenance = pending.mode === "retrospective" ? "retrospective" : "probe";
  for (const { q, answer } of answered) {
    store.appendFeedbackSync(
      buildFeedbackRecord({
        session_id: pending.session_id,
        area: q.area,
        question: q.question,
        options: q.options,
        answer,
        classification: q.classification,
        card_id: q.card_id,
        provenance,
        at: now,
      })
    );
  }
  for (const q of unanswered) {
    store.appendFeedbackSync(
      buildFeedbackRecord({
        session_id: pending.session_id,
        area: q.area,
        question: q.question,
        options: q.options,
        answer: "dismissed",
        classification: q.classification,
        card_id: q.card_id,
        provenance,
        at: now,
      })
    );
  }
  store.clearPending(pending.session_id);
  return 0;
}

try {
  process.exit(main() ?? 0);
} catch {
  process.exit(0);
}
