// signals-view.mjs — the RAW SIGNALS behind the Improver, assembled for reading
// and for deletion.
//
// Until now the review view listed proposals only. That made the Improver
// half-visible in the worst way: you could see its conclusions and not a single
// thing it concluded them from, so a wrong band or a wrong proposal had no
// visible cause and no way to correct it except editing a JSONL by hand.
//
// This module answers three questions per row, which is what makes the view
// worth having:
//   • WHAT was said, by which producer, when;
//   • WHAT IT CURRENTLY FEEDS — the improver's own feedback rule (which
//     direction, which accumulating group, how far from the min-signal bar) and
//     the shell's autonomy bands (which track, which signal);
//   • and therefore what deleting it would undo.
//
// Deletion is an append, never a rewrite — see feedback-signals.mjs. Everything
// here is a read except `tombstoneSignal`.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readFeedbackQueue,
  feedbackQueuePath,
  buildTombstone,
  trackContributionForRecord,
} from "./feedback-signals.mjs";
import { describeFeedbackSignal } from "./feedback-rule.mjs";
import { appendFeedbackSync } from "./probe-store.mjs";

function dataDir() {
  const o = process.env.IMPROVER_DATA;
  if (o && o.trim().length) return o;
  const home = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  return path.join(home, "improver");
}

// A record's dimensions, as the producer wrote them. `original` is what the
// system decided, `applied` what the operator would have chosen instead — the
// pair the feedback rule and the bands both read. Overrides carry the same two
// keys with {taskType, tier, flow, plan} inside, so one accessor serves both.
function dimensionsOf(rec) {
  const clean = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
  const original = clean(rec?.original);
  const applied = clean(rec?.applied);
  if (!original && !applied) return null;
  return { ...(original ? { original } : {}), ...(applied ? { applied } : {}) };
}

/** One queue entry, rendered honestly for the view. */
export function describeSignal(entry) {
  const rec = entry.record ?? {};
  const rule = describeFeedbackSignal(rec);
  const tracks = trackContributionForRecord(rec);
  return {
    key: entry.key,
    // Present only when the producer stamped one. Absent means the row is a
    // pre-id historical record and `key` is its line hash — which is exactly
    // what the delete route needs, so nothing here is degraded.
    id: typeof rec.id === "string" ? rec.id : null,
    provenance: typeof rec.provenance === "string" ? rec.provenance : "(unstamped)",
    area: rec.area ?? null,
    question: rec.question ?? null,
    answer: rec.answer ?? null,
    at: rec.timestamp ?? null,
    sessionId: rec.session_id ?? null,
    cardId: rec.card_id ?? null,
    decisionId: rec.decision_id ?? null,
    deliveredVia: rec.delivered_via ?? null,
    classification: rec.classification ?? null,
    dimensions: dimensionsOf(rec),
    // What it feeds RIGHT NOW. `feedsRule.category === null` is the common and
    // correct case: an approving answer proposes nothing, by design.
    feedsRule: rule,
    feedsTracks: tracks,
    contributes: Boolean(rule.category) || tracks.length > 0,
    tombstoned: entry.tombstoned,
    tombstonedAt: entry.tombstonedBy?.at ?? null,
    tombstoneReason: entry.tombstonedBy?.reason ?? null,
    lineNumber: entry.lineNumber,
  };
}

/** Every pending probe question, per session, labelled by delivery path. */
export function readPendingProbes(dir = dataDir()) {
  if (!existsSync(dir)) return [];
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.startsWith("probe-pending-") && f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const pending = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      if (!pending || typeof pending !== "object") continue;
      out.push({
        id: pending.id ?? null,
        sessionId: pending.session_id ?? null,
        mode: pending.mode ?? "probe",
        askedAt: pending.askedAt ?? null,
        target: pending.target ?? null,
        // Which surfaces this question actually reached. A question delivered
        // only through the blocking Stop-hook relay is one nobody may ever see;
        // the view says so rather than presenting it as "asked".
        deliveredVia: pending.deliveredVia ?? null,
        questions: Array.isArray(pending.questions) ? pending.questions : [],
        file: name,
      });
    } catch {
      /* unreadable pending — skip */
    }
  }
  return out.sort((a, b) => String(b.askedAt ?? "").localeCompare(String(a.askedAt ?? "")));
}

/** The tail of the probe-skip log: every time the Probe declined to ask, LOUDLY. */
export function readProbeSkips(dir = dataDir(), maxLines = 40) {
  const file = path.join(dir, "probe-skip.log");
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).slice(-maxLines).reverse();
  } catch {
    return [];
  }
}

/**
 * The whole Signals payload: raw records newest-first, plus the two things that
 * are NOT records but are just as much "signal state" — questions still waiting
 * for an answer, and the skips that explain a quiet Probe.
 */
export function collectSignals({ queueFile = feedbackQueuePath(), dir = dataDir(), cap = 500 } = {}) {
  const { entries, tombstones } = readFeedbackQueue(queueFile);
  const signals = entries.map(describeSignal).reverse().slice(0, cap);
  return {
    queueFile,
    signals,
    counts: {
      total: entries.length,
      live: entries.filter((e) => !e.tombstoned).length,
      deleted: entries.filter((e) => e.tombstoned).length,
      tombstones: tombstones.length,
      shown: signals.length,
    },
    pendingProbes: readPendingProbes(dir),
    probeSkips: readProbeSkips(dir),
  };
}

/**
 * Delete one signal: append a tombstone naming its key.
 *
 * Returns {ok:false, code:"not-found"} when no live record carries that key, so
 * the UI never reports a deletion that deleted nothing. Re-deleting an already
 * tombstoned record is a no-op success (the log already says what it needs to).
 */
export function tombstoneSignal(key, { reason, at, queueFile = feedbackQueuePath() } = {}) {
  const target = typeof key === "string" ? key.trim() : "";
  if (!target) return { ok: false, code: "bad-key" };
  const { entries } = readFeedbackQueue(queueFile);
  const entry = entries.find((e) => e.key === target);
  if (!entry) return { ok: false, code: "not-found" };
  if (entry.tombstoned) return { ok: true, alreadyDeleted: true, target };
  const tombstone = buildTombstone({ target, at, reason });
  appendFeedbackSync(tombstone, queueFile);
  return { ok: true, target, tombstone };
}
