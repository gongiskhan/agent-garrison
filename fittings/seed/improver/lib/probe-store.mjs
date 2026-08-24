// probe-store.mjs — the Improver Probe's I/O (paths, reads, the feedback-queue
// append, pending lifecycle, stale-pending sweep). Pending state, flags and the
// skip log are still node-local files; the feedback queue is the state service
// (feedback-signals.mjs owns that seam). The pure logic lives in probe-core.mjs.
// Kept dependency-light so the Stop-hook path stays fast and the module installs
// cleanly into the improver fitting's own dir (containment: probe machinery
// lives HERE).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  renameSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { dayStamp, buildFeedbackRecord } from "./probe-core.mjs";
import { appendFeedbackRecord } from "./feedback-signals.mjs";

// ── Paths (env-overridable for tests + non-default homes) ────────────────────
export function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length ? o : path.join(os.homedir(), ".garrison");
}

export function dataDir() {
  const o = process.env.IMPROVER_DATA;
  return o && o.trim().length ? o : path.join(garrisonHome(), "improver");
}

// PRE-MESH. The queue moved into the state service (feedback-signals.mjs); this
// path is where it lived before the importer renamed it `*.pre-mesh`, and is
// kept only as the honest answer to "where was this".
export function queuePath() {
  return path.join(garrisonHome(), "improver", "feedback-queue.jsonl");
}

// Pending is keyed PER SESSION (F1). A single global pending file would let ANY
// session's Stop (a background/pool session firing at T+91s) sweep an attended
// session's still-open question as dismissed and drop the real answer. With a
// per-session file a session only ever sweeps ITS OWN pending — which cannot be
// stale while that session's own AskUserQuestion tool blocks its turn.
function sanitizeSession(sessionId) {
  return String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
}

export function pendingPath(sessionId) {
  return path.join(dataDir(), `probe-pending-${sanitizeSession(sessionId)}.json`);
}

export function muteFlagPath(now) {
  return path.join(dataDir(), `probe-mute-${dayStamp(now)}`);
}

export function retroFlagPath(now) {
  return path.join(dataDir(), `retro-${dayStamp(now)}`);
}

export function skipLogPath() {
  return path.join(dataDir(), "probe-skip.log");
}

function claudeHome() {
  const o = process.env.GARRISON_CLAUDE_HOME?.trim();
  return o && o.length ? o : path.join(os.homedir(), ".claude");
}

// ── Input reads (tolerant: never throw, absent/garbage → empty) ──────────────
export function readSessionsState() {
  const p = process.env.GARRISON_SESSIONS_STATE || path.join(garrisonHome(), "sessions", "state.json");
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function readPolicy() {
  const p = process.env.GARRISON_POLICY_PATH || path.join(garrisonHome(), "orchestrator", "policy.json");
  return JSON.parse(readFileSync(p, "utf8")); // caller wants a LOUD failure when the policy is unreadable
}

// The two goal-sentinel homes (RUN_SPEC A5). Returns the paths that actually
// exist for this session, so probe-core.hasGoalSentinel can defer to the loop.
export function goalSentinelPaths(sessionId) {
  if (!sessionId) return [];
  const home = os.homedir();
  const candidates = [
    path.join(garrisonHome(), "sentinels", `${sessionId}.json`),
    path.join(home, ".autothing", "sentinels", `${sessionId}.json`),
  ];
  return candidates.filter((p) => existsSync(p));
}

// Read the composition's decisions.jsonl tail (E11). The composition dir is
// GARRISON_COMPOSITION_DIR (set by the runner) or an explicit override.
export function readDecisionsTail({ compositionDir, maxLines = 200 } = {}) {
  const dir = compositionDir || process.env.GARRISON_COMPOSITION_DIR;
  if (!dir) return [];
  const p = path.join(dir, ".garrison", "decisions.jsonl");
  return readJsonlTail(p, maxLines);
}

export function readTranscriptTail(transcriptPath, maxLines = 60) {
  if (!transcriptPath) return [];
  return readJsonlTail(transcriptPath, maxLines);
}

function readJsonlTail(file, maxLines) {
  if (!file || !existsSync(file)) return [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean);
  const tail = lines.slice(-maxLines);
  const out = [];
  for (const l of tail) {
    try {
      out.push(JSON.parse(l));
    } catch {
      /* skip unparseable line */
    }
  }
  return out;
}

// ── Kanban cards (best-effort, for classification + retrospective) ───────────
export function collectCards(cap = 500) {
  const root = process.env.GARRISON_KANBAN_DIR || path.join(garrisonHome(), "kanban-loop");
  const cardsDir = path.join(root, "cards");
  const cards = [];
  if (!existsSync(cardsDir)) return cards;
  let entries = [];
  try {
    entries = readdirSync(cardsDir, { withFileTypes: true });
  } catch {
    return cards;
  }
  for (const e of entries) {
    if (!e.isDirectory() || cards.length >= cap) continue;
    const f = path.join(cardsDir, e.name, "card.json");
    if (!existsSync(f)) continue;
    try {
      cards.push(JSON.parse(readFileSync(f, "utf8")));
    } catch {
      /* unreadable card — skip */
    }
  }
  return cards;
}

// ── Mute / retrospective flags ───────────────────────────────────────────────
export function isMutedToday(now) {
  return existsSync(muteFlagPath(now));
}

export function hasRetroFlagToday(now) {
  return existsSync(retroFlagPath(now));
}

export function touchRetroFlag(now) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(retroFlagPath(now), new Date(now || Date.now()).toISOString(), "utf8");
}

// ── Pending lifecycle (per-session, F1) ──────────────────────────────────────
export function readPending(sessionId) {
  const p = pendingPath(sessionId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// The pending carries its own session_id, so the file key is derived from it.
export function writePending(pending) {
  mkdirSync(dataDir(), { recursive: true });
  const p = pendingPath(pending?.session_id);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(pending, null, 2), "utf8");
  renameSync(tmp, p);
}

export function clearPending(sessionId) {
  const p = pendingPath(sessionId);
  if (!existsSync(p)) return;
  try {
    rmSync(p, { force: true });
  } catch {
    // last resort: empty the file — readPending() treats an empty/garbage file as "none"
    try {
      writeFileSync(p, "", "utf8");
    } catch {
      /* ignore */
    }
  }
}

// ── Feedback-queue append ────────────────────────────────────────────────────
// One record, one transaction in the state service. The O_APPEND single-write
// trick this used to rely on bought atomicity against the other two producers;
// a transaction is strictly stronger, and a duplicate id is now a 409 rather
// than a silent second copy.
//
// ASYNC, unavoidably — there is no synchronous HTTP. The Stop-hook path awaits
// it (probe-capture.mjs, probe-generate.mjs); a failure there propagates and the
// hook's own fail-safe decides what to do, which is the honest shape: a feedback
// record that could not be written must not be reported as written.
export async function appendFeedback(record, { client } = {}) {
  return appendFeedbackRecord(record, { client });
}

// ── Out-of-band delivery bookkeeping ─────────────────────────────────────────
// `deliveredVia` records WHICH surfaces a question actually reached:
//   { relay: true, channels: [fittingId…], answerBase, reachable }
// The relay is the blocking Stop-hook path; `channels` are the running Fittings
// that accepted the /notify push. The sweep below is the only consumer that
// branches on it, and it branches on `channels` alone.
export function updatePendingDelivery(sessionId, deliveredVia) {
  const pending = readPending(sessionId);
  if (!pending) return null;
  const next = { ...pending, deliveredVia };
  writePending(next);
  return next;
}

/** Find a pending by its own id (not its session), scanning the data dir. The
 *  answer route is reached from a notification, which carries the pending id and
 *  knows nothing about sessions. */
export function findPendingById(pendingId) {
  const id = String(pendingId || "");
  if (!id) return null;
  let names = [];
  try {
    names = readdirSync(dataDir()).filter((f) => f.startsWith("probe-pending-") && f.endsWith(".json"));
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const pending = JSON.parse(readFileSync(path.join(dataDir(), name), "utf8"));
      if (pending && pending.id === id) return pending;
    } catch {
      /* unreadable pending — skip */
    }
  }
  return null;
}

/** True when this pending reached a surface that does NOT expire in 90 seconds. */
export function wasDeliveredOutOfBand(pending) {
  const channels = pending?.deliveredVia?.channels;
  return Array.isArray(channels) && channels.length > 0;
}

// ── Stale-pending sweep (D26 dismissed) ──────────────────────────────────────
// Sweeps ONLY the given session's pending (F1). Write ONE explicit dismissed
// record per unanswered question so a timeout is distinguishable from an answer,
// then clear the pending. Returns the dismissed records (for logging/tests).
//
// TWO LIFETIMES, because there are now two delivery paths and the 90s figure was
// only ever right for one of them:
//
//   • RELAY ONLY (maxAgeMs, 90s). The question is open inside a blocking
//     AskUserQuestion in one session. That session's own turn is blocked while it
//     waits, so it never sweeps a question it is still waiting on; 90 seconds
//     past the ask means the operator pressed Escape or moved on.
//   • OUT OF BAND (outOfBandMaxAgeMs, 7 days). The question was pushed to a
//     channel and is sitting in a notification list. Nothing about it expires in
//     90 seconds — sweeping it there would silently discard a question the
//     operator can still answer, which is exactly the failure this pass exists to
//     end. The ceiling is generous but real: a question about a task from a week
//     ago is no longer answerable honestly.
//
// The dismissed record names the path that timed out, so "nobody was watching the
// terminal" and "it was pushed everywhere and still ignored" are never conflated.
export const RELAY_MAX_AGE_MS = 90_000;
export const OUT_OF_BAND_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function sweepStalePending({ now, sessionId, maxAgeMs = RELAY_MAX_AGE_MS, outOfBandMaxAgeMs = OUT_OF_BAND_MAX_AGE_MS } = {}) {
  const pending = readPending(sessionId);
  if (!pending || !pending.askedAt) return { swept: false, records: [] };
  const outOfBand = wasDeliveredOutOfBand(pending);
  const limit = outOfBand ? outOfBandMaxAgeMs : maxAgeMs;
  const age = Date.parse(now || new Date().toISOString()) - Date.parse(pending.askedAt);
  if (!(age >= limit)) return { swept: false, records: [], fresh: true };
  const deliveredVia = outOfBand
    ? `out-of-band:${pending.deliveredVia.channels.join(",")}`
    : "stop-hook-relay";
  const records = [];
  for (const q of Array.isArray(pending.questions) ? pending.questions : []) {
    const rec = buildFeedbackRecord({
      session_id: pending.session_id,
      area: q.area,
      question: q.question,
      options: q.options,
      answer: "dismissed",
      classification: q.classification,
      card_id: q.card_id,
      provenance: pending.mode === "retrospective" ? "retrospective" : "probe",
      delivered_via: deliveredVia,
      at: now || new Date().toISOString(),
    });
    await appendFeedback(rec);
    records.push(rec);
  }
  clearPending(pending.session_id);
  return { swept: true, records, outOfBand };
}

// ── Out-of-band answer capture ───────────────────────────────────────────────
/**
 * Record ONE answer to a pending question that came back from a channel rather
 * than from AskUserQuestion.
 *
 * It writes the SAME record `probe-capture.mjs` writes — buildFeedbackRecord
 * with the pending's own area/question/options/classification/card_id and the
 * pending's provenance — because the learning loop downstream
 * (feedback-rule.mjs) must not be able to tell the two paths apart. The only
 * addition is `delivered_via`, which is descriptive and nothing branches on.
 *
 * Partial answers are supported: the answered question is removed from the
 * pending and the pending is only cleared once none remain. A retrospective asks
 * up to four, and losing three because one was answered from a phone would be a
 * worse bug than the one this path fixes.
 */
export async function recordProbeAnswer({ pendingId, questionIndex = 0, answer, now, deliveredVia = "out-of-band" } = {}) {
  const pending = findPendingById(pendingId);
  if (!pending) return { ok: false, code: "not-found" };
  const questions = Array.isArray(pending.questions) ? pending.questions : [];
  const idx = Number(questionIndex);
  const q = Number.isInteger(idx) && idx >= 0 && idx < questions.length ? questions[idx] : null;
  if (!q) return { ok: false, code: "no-such-question", questions: questions.length };
  if (answer == null || !String(answer).trim()) return { ok: false, code: "empty-answer" };
  const at = now || new Date().toISOString();
  const record = buildFeedbackRecord({
    session_id: pending.session_id,
    area: q.area,
    question: q.question,
    options: q.options,
    answer: String(answer),
    classification: q.classification,
    card_id: q.card_id,
    provenance: pending.mode === "retrospective" ? "retrospective" : "probe",
    delivered_via: deliveredVia,
    at,
  });
  await appendFeedback(record);
  const remaining = questions.filter((_, i) => i !== idx);
  if (remaining.length) {
    writePending({ ...pending, questions: remaining });
    return { ok: true, record, remaining: remaining.length };
  }
  clearPending(pending.session_id);
  return { ok: true, record, remaining: 0, cleared: true };
}

// ── Skip logging (fail LOUD, never silent) ───────────────────────────────────
export function logSkip(line, now) {
  const stamped = `${now || new Date().toISOString()} ${line}\n`;
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(skipLogPath(), stamped, "utf8");
  } catch {
    /* ignore — still surfaced on stderr below */
  }
  process.stderr.write(`probe-skip: ${line}\n`);
}
