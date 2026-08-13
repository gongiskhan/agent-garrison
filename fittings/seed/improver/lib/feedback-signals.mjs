// feedback-signals.mjs — the ONE reader of the shared feedback queue
// (~/.garrison/improver/feedback-queue.jsonl), and the documented home of the
// record-id format its three producers stamp.
//
// THREE concurrent writers append to that file, each with its own O_APPEND
// single-write contract:
//   • the gateway's conversational overrides   (http-gateway/scripts/lib/feedback-queue.mjs
//                                               buildOverrideRecord, provenance "override")
//   • the Probe's answers + dismissals         (probe-core.mjs buildFeedbackRecord,
//                                               provenance "probe" / "retrospective")
//   • the Decisions panel's verdicts           (src/lib/decision-verdicts.ts
//                                               buildVerdictRecord, provenance "decision-verdict")
//
// Two consequences drive everything here.
//
// 1. DELETE IS A TOMBSTONE, NEVER A REWRITE. Filtering the file and writing it
//    back races all three appenders: a writer that opened the file before the
//    rewrite lands its line at the OLD offset and the tail is silently lost.
//    So a deletion is itself an append — {kind:"tombstone", target, at, reason} —
//    and every reader drops the records a tombstone names. The log stays
//    append-only, which is also what keeps a deletion auditable.
//
// 2. A RECORD NEEDS A STABLE HANDLE to be tombstoned. New records carry a minted
//    `id`. The records already on disk (written before ids existed) have none, so
//    they get a key DERIVED from their raw line. That derivation must be
//    byte-identical in every reader — the .mjs readers here and the shell's
//    TypeScript reader (src/lib/routing-tracks.ts) — or a record deleted in the
//    Signals view would keep feeding the home page's autonomy bands.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

// ── Paths ────────────────────────────────────────────────────────────────────
// Byte-identical to probe-store.queuePath() and the gateway's
// improverQueuePath(): all three must name ONE file or the loop silently splits.
export function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length ? o : path.join(os.homedir(), ".garrison");
}

export function feedbackQueuePath() {
  return path.join(garrisonHome(), "improver", "feedback-queue.jsonl");
}

// ── The id format (source of truth) ──────────────────────────────────────────
// `fq-<9 chars base36 millis>-<8 hex random>`. Fixed-width timestamp prefix so
// ids sort lexicographically by mint time (the ULID property the board's card
// ids rely on), 32 bits of randomness so two producers appending in the same
// millisecond do not collide.
//
// Deliberately NOT the board's ulid.mjs: that lives in the kanban-loop fitting
// and cross-fitting imports are forbidden, and two of the three producers here
// are in other packages anyway (one of them a "use client"-reachable TS module
// that cannot import node:crypto at all). So the FORMAT is the shared thing and
// each producer carries its own six-line minter pointing back here. Web Crypto
// (`globalThis.crypto`) rather than node:crypto for exactly that reason: it is
// the one RNG all three can call.
export const FEEDBACK_ID_PREFIX = "fq-";

export function mintFeedbackId(at) {
  const parsed = Date.parse(at ?? "");
  const ms = Number.isFinite(parsed) ? parsed : Date.now();
  const stamp = Math.max(0, ms).toString(36).padStart(9, "0").slice(-9);
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${FEEDBACK_ID_PREFIX}${stamp}-${rand}`;
}

// ── The derived key for id-less historical records ───────────────────────────
// sha256 of the raw line, TRIMMED (the only normalisation, since a reader may or
// may not have stripped the newline) and truncated to 32 hex chars — 128 bits,
// far more than enough to name one line of one file. The `raw:` prefix makes a
// tombstone self-describing: it says "this targets a line hash", not a minted id.
//
// Two identical lines (the same answer given twice in the same millisecond)
// share a key and are deleted together. That is the honest behaviour: nothing
// on disk distinguishes them, so nothing here can pretend to.
export const DERIVED_KEY_PREFIX = "raw:";

export function derivedKeyForLine(rawLine) {
  return `${DERIVED_KEY_PREFIX}${createHash("sha256").update(String(rawLine ?? "").trim()).digest("hex").slice(0, 32)}`;
}

/** The handle a tombstone can name: the record's minted id, else its line hash. */
export function keyForRecord(record, rawLine) {
  const id = record && typeof record.id === "string" ? record.id.trim() : "";
  return id.length ? id : derivedKeyForLine(rawLine);
}

// ── Tombstones ───────────────────────────────────────────────────────────────
export const TOMBSTONE_KIND = "tombstone";

export function isTombstone(record) {
  return Boolean(record) && typeof record === "object" && record.kind === TOMBSTONE_KIND;
}

export function buildTombstone({ target, at, reason } = {}) {
  const t = typeof target === "string" ? target.trim() : "";
  if (!t) return null;
  return {
    kind: TOMBSTONE_KIND,
    target: t,
    at: at ?? new Date().toISOString(),
    ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}),
  };
}

// ── Parsing ──────────────────────────────────────────────────────────────────
/**
 * Parse the queue text into entries in FILE order.
 *
 * Two passes are unavoidable: a tombstone is appended AFTER the record it
 * deletes, so nothing can be decided about line N until the whole file is read.
 *
 * Returns { entries, tombstones }, where an entry is
 *   { key, record, raw, lineNumber, tombstoned, tombstonedBy }
 * `entries` excludes the tombstone lines themselves (they are not signals) and
 * unparseable lines (a shared append-only log picks those up occasionally).
 */
export function parseFeedbackQueue(text) {
  const rows = [];
  const tombstones = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue; // malformed line: skipped, never fatal
    }
    if (isTombstone(record)) {
      tombstones.push({ ...record, lineNumber: i + 1 });
      continue;
    }
    rows.push({ key: keyForRecord(record, raw), record, raw, lineNumber: i + 1 });
  }
  const byTarget = new Map();
  for (const t of tombstones) if (typeof t.target === "string") byTarget.set(t.target, t);
  const entries = rows.map((r) => {
    const t = byTarget.get(r.key) ?? null;
    return { ...r, tombstoned: Boolean(t), tombstonedBy: t };
  });
  return { entries, tombstones };
}

/** Read + parse the queue. An absent or unreadable file reads as empty. */
export function readFeedbackQueue(file = feedbackQueuePath()) {
  if (!existsSync(file)) return { entries: [], tombstones: [], file };
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { entries: [], tombstones: [], file };
  }
  return { ...parseFeedbackQueue(text), file };
}

/** The records a consumer should actually learn from: everything not deleted. */
export function liveRecords(entries) {
  return (entries ?? []).filter((e) => !e.tombstoned).map((e) => e.record);
}

// ── What a record currently feeds ────────────────────────────────────────────
// The Signals view has to answer "why is this row here / what does deleting it
// change?", and the honest answer names the two consumers by name.
//
// MIRROR — SOURCE OF TRUTH: src/lib/routing-tracks.ts `evidenceFromVerdict`.
// That reader folds verdicts into the autonomy bands on the home page. It is
// TypeScript in the shell and cannot be imported from a fitting, so the rule is
// replicated here and `tests/improver-signals.test.ts` runs BOTH over the same
// producer-built fixtures and asserts they agree. Change one without the other
// and that test fails — which is the only reason this duplication is allowed.
const VERDICT_PROVENANCE = "decision-verdict";
const str = (v) => (typeof v === "string" && v.trim().length > 0 ? v : null);
const submap = (v) => (!v || typeof v !== "object" || Array.isArray(v) ? {} : v);

export function trackContributionForRecord(record) {
  if (!record || typeof record !== "object") return [];
  if (str(record.provenance) !== VERDICT_PROVENANCE) return [];
  const verdict = str(record.answer);
  if (verdict !== "right" && verdict !== "wrong") return []; // incl. "unsure": inert by design
  const original = submap(record.original);
  const applied = submap(record.applied);
  const shape = str(original.flow) ?? str(original.duty) ?? "unknown";
  if (verdict === "right") {
    return [
      { category: "flow", shape, signal: "explicit-confirmation" },
      { category: "level", shape, signal: "explicit-confirmation" },
    ];
  }
  const out = [];
  if (str(applied.flow)) out.push({ category: "flow", shape, signal: "explicit-negative" });
  if (str(applied.tier) || str(applied.duty)) out.push({ category: "level", shape, signal: "explicit-negative" });
  if (!out.length) {
    out.push(
      { category: "flow", shape, signal: "explicit-negative" },
      { category: "level", shape, signal: "explicit-negative" }
    );
  }
  return out;
}
