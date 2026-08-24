// feedback-queue.mjs — the Improver evidence queue writer (GARRISON-FLOW-V2 D20).
//
// Conversational overrides are the first evidence the gateway records here: when
// the operator's words reclassify the work ("full pipeline", "just do it
// quickly", "run in the background"), the gateway appends ONE override event to
// the shared feedback queue carrying BOTH the prior resolution and the applied
// one. The nightly Improver consumes the queue as high-weight
// evidence (S8 wires the consumer + the probe/retrospective writers that share
// this file + schema). Agreement — the operator not overriding — is never
// recorded per turn; only a real override leaves a mark.
//
// The queue is append-only and now lives in the state service (POST /v1/feedback
// into `feedback_queue`): one record per call, one transaction, shared by every
// node. It used to be a JSONL file three writers held open in O_APPEND.

import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createStateClient } from "./state-client.mjs";

// PRE-MESH. Where the queue lived before the importer moved it into the service
// and renamed the file `*.pre-mesh`. Nothing on the live path reads or writes it.
export function improverQueuePath() {
  const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  return path.join(home, "improver", "feedback-queue.jsonl");
}

// One client per gateway process, built lazily: importing this module must not
// require the node to be enrolled (detectOverride/buildOverrideRecord are pure
// and are imported by tests that never write).
let cachedClient = null;
function stateClient(client = null) {
  if (client) return client;
  cachedClient ??= createStateClient({ readFileSync });
  return cachedClient;
}

/** Drop the cached client (token rotation, tests). */
export function resetFeedbackClient() {
  cachedClient = null;
}

// IMPERATIVE override phrasings (the brief's examples + close variants), mapped to
// the plan they force: "full" → multi-phase engine-dispatched run; "quick" →
// trivial plan, run inline. Deterministic so the gateway records the SAME override
// the operator's words describe, immune to classifier drift. Kept to directive
// phrasings — NOT loose adverbs like "quickly just" that false-positive on
// narration ("I quickly just realized …", S7 review F2).
const OVERRIDE_RULES = [
  { plan: "full", re: /\b(run (this|it|that) with )?the full pipeline\b/i },
  { plan: "full", re: /\bfull pipeline\b/i },
  { plan: "full", re: /\brun (this|it|that)?\s*in the background\b/i },
  { plan: "full", re: /\bkick off (a|the) (full )?build\b/i },
  { plan: "quick", re: /\b(just )?do it quickly\b/i },
  { plan: "quick", re: /\b(just )?keep it quick\b/i },
  { plan: "quick", re: /\bskip the (ceremony|pipeline|gates)\b/i },
];

// Detect a conversational override in the operator's message. Returns
// { answer, plan } (plan: "quick" | "full") or null when no phrase matches.
// `answer` is the matched phrase verbatim. Guarded so an override only fires when
// the phrase is DIRECTED at the task — a short directive message OR the phrase in
// the leading clause — never mid-narrative in a long sentence (F2).
const DIRECTIVE_MAX_LEN = 120; // a short imperative, not a paragraph
const LEADING_WINDOW = 40; // "actually, run the full pipeline" — phrase near the front
export function detectOverride(message) {
  const text = String(message || "");
  const short = text.trim().length <= DIRECTIVE_MAX_LEN;
  for (const rule of OVERRIDE_RULES) {
    const m = text.match(rule.re);
    if (m && (short || m.index <= LEADING_WINDOW)) return { answer: m[0], plan: rule.plan };
  }
  return null;
}

// Mint the queue-record id.
//
// FORMAT SOURCE OF TRUTH: improver/lib/feedback-signals.mjs (`mintFeedbackId`) —
// `fq-<9 chars base36 millis>-<8 hex random>`. Replicated rather than imported
// because that module lives in the improver fitting, a separate installed
// package at runtime, and a cross-fitting import would break this fitting's
// containment (the same reason probe-core.mjs replicates promptDigest).
//
// The id is what makes a record DELETABLE: deletion is a tombstone appended to
// this same queue naming this id, never a rewrite of the file — three writers
// hold it open in O_APPEND and a filter-rewrite would drop whichever lines
// landed between the read and the write.
function mintFeedbackId(at) {
  const parsed = Date.parse(at ?? "");
  const ms = Number.isFinite(parsed) ? parsed : Date.now();
  const stamp = Math.max(0, ms).toString(36).padStart(9, "0").slice(-9);
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `fq-${stamp}-${rand}`;
}

// Build the D20 override feedback record. `original`/`applied` are the prior and
// applied resolutions ({taskType, tier, flow, plan}); the caller supplies
// them so this stays pure/testable. session_id is optional (absent on channels
// that don't carry one).
export function buildOverrideRecord({ session_id, answer, original, applied, at } = {}) {
  const rec = {};
  rec.id = mintFeedbackId(at);
  if (session_id != null && String(session_id).length) rec.session_id = String(session_id);
  rec.area = "orchestrator";
  rec.question = "override";
  rec.answer = answer ?? null;
  rec.original = original ?? null;
  rec.applied = applied ?? null;
  rec.timestamp = at ?? new Date().toISOString();
  rec.provenance = "override";
  return rec;
}

// Append one record. Returns the service's {id, seq} — the id is the one the
// producer minted above, which the service enforces UNIQUE, so a retry that
// lands twice is a 409 rather than a duplicate signal.
//
// MIRROR — SOURCE OF TRUTH: improver/lib/feedback-signals.mjs
// `feedbackRowFromRecord`. Replicated rather than imported for the same reason
// `mintFeedbackId` is: that module lives in the improver fitting, a separate
// installed package at runtime, and a cross-fitting import would break this
// fitting's containment. The payload is the record VERBATIM, so a reader
// reconstructs exactly the line this used to write; the promoted columns are a
// query convenience and `payload.provenance` stays the discriminator.
//
// FAILS LOUD: no local fallback file. A feedback loop that silently splits in
// two is worse than one that stops and says so — every caller here already logs
// the failure and carries on with the turn.
export async function appendFeedback(record, { client } = {}) {
  const rec = record && typeof record === "object" ? record : {};
  const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : undefined;
  const kind = typeof rec.provenance === "string" && rec.provenance.trim() ? rec.provenance.trim() : undefined;
  const area = typeof rec.area === "string" && rec.area.trim() ? rec.area.trim() : undefined;
  const sessionId = typeof rec.session_id === "string" && rec.session_id.trim() ? rec.session_id.trim() : undefined;
  return stateClient(client).appendFeedback({
    ...(id ? { id } : {}),
    ...(kind ? { kind } : {}),
    ...(area ? { area } : {}),
    ...(sessionId ? { sessionId } : {}),
    payload: rec,
  });
}
