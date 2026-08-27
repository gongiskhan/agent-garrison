// routing-autonomy.mjs — graduated autonomy for ROUTING decisions
// (ORCHESTRATOR_COHERENCE.md §7 / brief §7).
//
// The router picks a flow and a level for every request. This module decides how
// much freedom it has to act on that pick without asking, learns from what
// Gonçalo does about it, and refuses to ask more often than is useful.
//
// Three things live here because they are one mechanism:
//
//   1. THE SIGNAL REGISTRY (§7.4). Not every correction is worth the same. A redo
//      with overrides is a proven error PLUS the ground truth, so it is the
//      strongest thing that can happen. Silence is near zero — silence is not
//      approval, and treating it as approval is how a system convinces itself it
//      is doing well while quietly annoying its user.
//
//   2. THE BANDS (§7.1). Below the lower threshold: ask first. In the middle:
//      act, and offer to revert. Above the upper: act, and only inform. Bands are
//      per (category, shape), never global — a router reliable on small fixes can
//      still be unreliable on automations, and one global number would let the
//      easy cases buy freedom for the hard ones.
//
//   3. THE REVERSIBILITY TAXONOMY (§8.4). Bands grant freedom to ACT; this decides
//      what "act" is allowed to mean. A band never authorises an irreversible
//      action. Code under git can be undone in one action; a message that has left
//      the building cannot.
//
// Pure and injectable. No clock, no I/O — `now` is always passed in, so the same
// inputs always produce the same decision and a test can drive a whole day.

// ── 1. The signal registry ──────────────────────────────────────────────────
//
// `weight` is how much the signal moves the track record; `polarity` is which way.
// `recurrenceBoost` multiplies the weight the more often the SAME signal recurs on
// the SAME shape — the ordering the brief specifies is mostly about how much
// ground truth came with the signal, but a repeated manual override stops being a
// preference and starts being evidence the config is wrong.

export const SIGNALS = Object.freeze({
  // Proven error AND the ground truth, in one action. Nothing beats it.
  "redo-with-overrides": { weight: 1.0, polarity: "negative", recurrenceBoost: 1.0 },
  // "This was wrong, and here is what it should have been."
  "explicit-negative": { weight: 0.85, polarity: "negative", recurrenceBoost: 1.0 },
  // "just add the task" — a correction mid-conversation, no ceremony.
  "mid-conversation-correction": { weight: 0.7, polarity: "negative", recurrenceBoost: 1.0 },
  // A pin set BEFORE the run. Weak alone (it may be taste), strong when it repeats.
  "manual-override": { weight: 0.5, polarity: "negative", recurrenceBoost: 1.6 },
  // A router escalation. Weighted like a manual override and boosted HARDER by
  // recurrence: a repeating escalation is the system telling you the flow
  // definition is wrong, not telling you anything about the card in front of it.
  escalation: { weight: 0.5, polarity: "negative", recurrenceBoost: 2.2 },
  // Someone said yes on purpose.
  "explicit-confirmation": { weight: 0.3, polarity: "positive", recurrenceBoost: 1.0 },
  // Nobody said anything. Nearly worthless, and deliberately so.
  silence: { weight: 0.02, polarity: "positive", recurrenceBoost: 1.0 }
});

export const SIGNAL_KINDS = Object.freeze(Object.keys(SIGNALS));

/** Decision categories the bands apply to, separately. */
export const CATEGORIES = Object.freeze(["flow", "level"]);

// ── 2. Reversibility ────────────────────────────────────────────────────────

export const REVERSIBILITY = Object.freeze({
  /** Undone by one action: a git revert, a card moved back. */
  "one-action": { autonomous: true, revertable: true },
  /** Undone, but it costs something: a deploy, a schema change on a product with no users. */
  effortful: { autonomous: true, revertable: true },
  /** Cannot be undone once it happens: an outbound message, an external side effect. */
  irreversible: { autonomous: false, revertable: false }
});

/** What kind of action each thing the router can decide to do actually is. */
export const ACTION_REVERSIBILITY = Object.freeze({
  "code-change": "one-action",
  "card-state": "one-action",
  "card-create": "one-action",
  "config-edit": "one-action",
  deploy: "effortful",
  "outbound-message": "irreversible",
  "external-side-effect": "irreversible"
});

export function reversibilityOf(action) {
  return ACTION_REVERSIBILITY[action] ?? "irreversible"; // unknown ⇒ treat as unsafe
}

/** Seconds an outbound message sits in the send buffer so it stays cancellable.
 *  An irreversible action becomes revertible-in-practice inside this window,
 *  which is the only reason autonomy may touch it at all. */
export const OUTBOUND_DELAY_SECONDS = 60;

// ── 3. The track record ─────────────────────────────────────────────────────

export const DEFAULT_THRESHOLDS = Object.freeze({
  /** Below this, ask first. */
  lower: 0.8,
  /** At or above this, act and only inform. */
  upper: 0.95,
  /** Decisions needed before a track record means anything at all. */
  minObservations: 5,
  /** Questions per day, across everything. */
  maxQuestionsPerDay: 5
});

/** How much evidence a shape must accumulate before a clean record reads as
 *  confidence. Without it, confidence is a pure ratio and ONE unopposed
 *  observation scores 1.0. */
export const EVIDENCE_PRIOR = 0.25;

/** The most that silence, in aggregate, may ever contribute. Silence has weight
 *  because ignoring it entirely would be its own distortion, but a ratio has no
 *  memory of how thin the evidence is: with no corrections at all, ANY amount of
 *  silence divides to 1.0 and buys the top band. Capping it below the lower
 *  threshold means no quantity of saying nothing can ever authorise acting
 *  unannounced — which is the brief's "silence is not approval", enforced. */
export const SILENCE_CAP = 0.75;

export function emptyTrack(overrides = {}) {
  return {
    observations: 0,
    positive: 0,
    /** Positive weight contributed by silence alone, capped separately. */
    silencePositive: 0,
    negative: 0,
    /** signalKind -> times seen on this shape, for the recurrence boost. */
    recurrence: {},
    /** Set when a demotion happened, so the band can be held down briefly. */
    demotedAt: null,
    ...overrides
  };
}

const signalSpec = (kind) => SIGNALS[kind] ?? null;

/** Fold one signal into a track record. Pure; returns a new record. */
export function recordSignal(track, kind, { at = null } = {}) {
  const spec = signalSpec(kind);
  if (!spec) return track; // unknown signal changes nothing rather than guessing
  const next = {
    ...track,
    recurrence: { ...(track.recurrence || {}) },
    observations: (track.observations || 0) + 1
  };
  const seen = (next.recurrence[kind] || 0) + 1;
  next.recurrence[kind] = seen;
  // Recurrence multiplies toward the boost ceiling, so the second occurrence
  // already counts for more and the fifth is close to the cap.
  const boost = 1 + (spec.recurrenceBoost - 1) * (1 - 1 / seen);
  const weight = spec.weight * boost;
  if (spec.polarity === "negative") {
    next.negative = (track.negative || 0) + weight;
    next.demotedAt = at ?? track.demotedAt ?? null;
  } else if (kind === "silence") {
    next.silencePositive = (track.silencePositive || 0) + weight;
  } else {
    next.positive = (track.positive || 0) + weight;
  }
  return next;
}

/**
 * Confidence that the router gets THIS shape right, in [0,1].
 *
 * Starts pessimistic: with no evidence a shape is not trusted, because the
 * failure mode of an over-confident cold start is acting wrongly and
 * unannounced on work nobody has checked.
 */
export function confidenceOf(track, thresholds = DEFAULT_THRESHOLDS) {
  const t = track || emptyTrack();
  const obs = t.observations || 0;
  // Deliberate positives count in full; silence counts up to its cap and no
  // further, so no amount of saying nothing reaches the acting bands.
  const pos = (t.positive || 0) + Math.min(t.silencePositive || 0, SILENCE_CAP);
  const neg = t.negative || 0;
  // The prior sits in the denominator so thin evidence cannot divide to 1.0.
  const raw = pos / (pos + neg + EVIDENCE_PRIOR);
  const floor = thresholds.minObservations ?? DEFAULT_THRESHOLDS.minObservations;
  if (obs < floor) {
    // Not enough evidence to be confident at all. Scale by how far short it
    // falls, so 4 clean observations still beat none.
    return raw * (obs / floor);
  }
  return raw;
}

/**
 * The band for a (category, shape).
 *
 * `action` gates the outcome through the reversibility taxonomy: however good the
 * track record, an irreversible action never gets act-and-inform. That is the
 * brief's rule that bands apply only to reversible categories, enforced here
 * rather than left to each caller to remember.
 */
export function bandFor(track, { thresholds = DEFAULT_THRESHOLDS, action = "code-change", now = null } = {}) {
  const conf = confidenceOf(track, thresholds);
  const rev = reversibilityOf(action);
  const spec = REVERSIBILITY[rev];

  let band = conf >= thresholds.upper ? "act-inform" : conf >= thresholds.lower ? "act-revert" : "ask";

  // Immediately after a demotion, hold the band down for one decision even if the
  // arithmetic recovers — a correction should be felt.
  if (track?.demotedAt && now && track.demotedAt === now) band = "ask";

  if (!spec.autonomous) {
    // Irreversible: never act-and-inform. The best it can reach is act-with-a-
    // cancellation-window, and only from the top band.
    band = band === "act-inform" ? "act-revert" : "ask";
  }
  return {
    band,
    confidence: conf,
    reversibility: rev,
    /** Outbound work is only allowed to act because it can be cancelled. */
    delaySeconds: rev === "irreversible" && band === "act-revert" ? OUTBOUND_DELAY_SECONDS : 0
  };
}

// ── 4. Anti-fatigue ─────────────────────────────────────────────────────────
//
// Asking is expensive: every low-value question spends the credibility of the
// next one, and a system that asks about everything trains its user to answer
// without reading. So a question has to earn its place.

export const ASK_REASONS = Object.freeze([
  "cold-start", // no track record for this shape at all
  "near-boundary", // close to a promotion/demotion threshold, so the answer moves the band
  "post-demotion", // something just went wrong here
  "recurring-override" // "you have set this three times — make it the default?"
]);

/**
 * Should the router ask about this decision now?
 *
 * Returns { ask, reason, defer } — `defer: true` means the question is real but
 * low priority, so it belongs in the digest rather than interrupting.
 */
export function shouldAsk(
  track,
  { thresholds = DEFAULT_THRESHOLDS, askedToday = 0, action = "code-change", now = null } = {}
) {
  const { band, confidence } = bandFor(track, { thresholds, action, now });
  const obs = track?.observations || 0;

  const reason =
    obs === 0
      ? "cold-start"
      : track?.demotedAt && track.demotedAt === now
        ? "post-demotion"
        : nearBoundary(confidence, thresholds)
          ? "near-boundary"
          : recurringOverride(track)
            ? "recurring-override"
            : null;

  if (band !== "ask" && !reason) return { ask: false, reason: null, defer: false };

  // The rate limit never suppresses a question the band REQUIRES (the router is
  // not allowed to act on those), it only defers the ones asked for information
  // value. A hard cap on required questions would mean acting unasked.
  const overBudget = askedToday >= (thresholds.maxQuestionsPerDay ?? DEFAULT_THRESHOLDS.maxQuestionsPerDay);
  if (band === "ask") return { ask: true, reason: reason ?? "low-confidence", defer: false };
  return overBudget ? { ask: false, reason, defer: true } : { ask: true, reason, defer: false };
}

function nearBoundary(confidence, thresholds) {
  const margin = 0.03;
  return (
    Math.abs(confidence - thresholds.lower) <= margin || Math.abs(confidence - thresholds.upper) <= margin
  );
}

function recurringOverride(track) {
  const r = track?.recurrence || {};
  return (r["manual-override"] || 0) >= 3 || (r.escalation || 0) >= 3;
}

// ── 5. Cold start ───────────────────────────────────────────────────────────

/**
 * Seed track records from historical tasks so a brand-new library does not ask
 * about everything in week one — which would collide with the anti-fatigue rules
 * and destroy answer quality exactly when the answers matter most.
 *
 * Each entry is {shape, category, correct} — `correct` meaning the label the
 * mining says SHOULD have run. A seeded observation counts as a confirmation,
 * but at silence-level weight: it is inferred history, not something Gonçalo
 * actually said, and it must never be able to buy the top band on its own.
 */
export function seedFromHistory(entries, { weight = SIGNALS.silence.weight } = {}) {
  const tracks = {};
  for (const e of entries || []) {
    if (!e || !e.shape || !CATEGORIES.includes(e.category)) continue;
    const key = trackKey(e.category, e.shape);
    const t = tracks[key] ?? emptyTrack();
    tracks[key] = {
      ...t,
      observations: t.observations + 1,
      positive: t.positive + weight,
      recurrence: t.recurrence
    };
  }
  return tracks;
}

export function trackKey(category, shape) {
  return `${category}:${shape}`;
}
