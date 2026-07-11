// feedback-queue.mjs — the Improver evidence queue writer (GARRISON-FLOW-V2 D20).
//
// Conversational overrides are the first evidence the gateway records here: when
// the operator's words reclassify the work ("full pipeline", "just do it
// quickly", "run in the background"), the gateway appends ONE override event to
// ~/.garrison/improver/feedback-queue.jsonl carrying BOTH the prior resolution
// and the applied one. The nightly Improver consumes the queue as high-weight
// evidence (S8 wires the consumer + the probe/retrospective writers that share
// this file + schema). Agreement — the operator not overriding — is never
// recorded per turn; only a real override leaves a mark.
//
// The queue is a single-writer, append-only JSONL: one complete record per
// appendFile call (the same atomicity the routing telemetry relies on).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The improver evidence queue path. GARRISON_HOME wins (tests + non-default
// homes), else ~/.garrison — the same resolution the board discovery uses.
export function improverQueuePath() {
  const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  return path.join(home, "improver", "feedback-queue.jsonl");
}

// The three example override phrases (and close variants) the brief names, mapped
// to the plan they force: "full"/"engine" → multi-phase engine-dispatched run;
// "quick" → trivial plan, run inline. Deterministic so the gateway records the
// SAME override the operator's words describe, immune to classifier drift.
const OVERRIDE_RULES = [
  { plan: "full", re: /\b(full pipeline|the full pipeline|full build|run the full|do the full)\b/i },
  { plan: "full", re: /\brun (this|it|that)?\s*in the background\b/i },
  { plan: "full", re: /\bkick off (a|the) build\b/i },
  { plan: "quick", re: /\b(just )?do it quickly\b/i },
  { plan: "quick", re: /\b(just )?(keep it|make it|do it) quick\b/i },
  { plan: "quick", re: /\bquick(ly)?,? just\b/i },
];

// Detect a conversational override in the operator's message. Returns
// { answer, plan } (plan: "quick" | "full") or null when no phrase matches.
// `answer` is the matched phrase verbatim — the human-readable override the
// Improver reads.
export function detectOverride(message) {
  const text = String(message || "");
  for (const rule of OVERRIDE_RULES) {
    const m = text.match(rule.re);
    if (m) return { answer: m[0], plan: rule.plan };
  }
  return null;
}

// Build the D20 override feedback record. `original`/`applied` are the prior and
// applied resolutions ({taskType, tier, workKind, plan}); the caller supplies
// them so this stays pure/testable. session_id is optional (absent on channels
// that don't carry one).
export function buildOverrideRecord({ session_id, answer, original, applied, at } = {}) {
  const rec = {};
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

// Append one record as a single JSON line, creating the queue (and its dir) on
// first write. One appendFile call per record keeps concurrent single-writer
// appends from interleaving.
export async function appendFeedback(record, file = improverQueuePath()) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, JSON.stringify(record) + "\n", "utf8");
  return file;
}
