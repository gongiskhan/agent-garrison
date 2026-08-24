// autonomy-consult.mjs - the DECISION-TIME consult of the autonomy bands
// (ORCHESTRATOR_COHERENCE.md §7.1 / §7.5).
//
// routing-autonomy.mjs has always known how to answer "how much freedom does the
// router have on this shape?". Nothing ever asked it. The router had exactly one
// behaviour - decide and go - so the bands, the signal registry, the cold-start
// seed and the escalation evidence were a measurement nobody read. This module is
// the reader: the gateway calls it the moment a route resolves, and the answer
// decides whether the work runs unannounced, runs with an offer to revert, or
// waits for a "go".
//
// It exists in the ORCHESTRATOR fitting, next to the core it consults, because
// the gateway loads it the same way it loads dispatch-core and the level chain:
// a dynamic import from the resolved orchestrator dir. The shell has its own
// reader of the same evidence (src/lib/routing-tracks.ts, which serves the
// Autonomy panel), and a fitting cannot import from src/lib - so the FOLD is
// implemented twice on purpose and pinned together by a parity test
// (tests/autonomy-consult.test.ts). If the two ever disagree, the panel is
// showing a band the router did not act on, which is the exact
// "confident for reasons nobody can reconstruct" failure the derived-tracks
// design exists to prevent.
//
// Everything here is DERIVED. There is no counter, no accumulated state, no
// cache of a band: every call re-folds the two append-only logs. The feedback
// queue moved into the state service (mesh phase 2, §4.5) and is read through
// GET /v1/feedback, which drops tombstoned rows in SQL; the decisions log is
// high-volume audit and stays node-local. These are dispatch-time calls (one per
// routed turn, already behind a model call), so correctness beats cleverness and
// nothing here is optimised.
//
// The ONE piece of state is the ask budget - a dated counter of questions
// actually posed - and it lives in its own tiny file so deleting it resets the
// day rather than corrupting the evidence.

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createStateClient } from "./state-client.mjs";

import {
  CATEGORIES,
  DEFAULT_THRESHOLDS,
  bandFor,
  emptyTrack,
  recordSignal,
  seedFromHistory,
  shouldAsk,
  trackKey
} from "./routing-autonomy.mjs";
import { expandAutonomySeed } from "./autonomy-seed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The shipped cold-start seed. A composition's own copy overrides it. */
const SHIPPED_SEED_PATH = path.join(HERE, "..", "config", "autonomy-seed.json");

/** Where each log lives, relative to the two roots the caller passes.
 *  FEEDBACK_QUEUE_REL is PRE-MESH: the queue is the state service now, and the
 *  path survives only for a transition read of a leftover `*.pre-mesh` file. */
export const FEEDBACK_QUEUE_REL = path.join("improver", "feedback-queue.jsonl");
export const DECISIONS_REL = path.join(".garrison", "decisions.jsonl");
export const ASK_BUDGET_REL = path.join(".garrison", "ask-budget.json");
export const SEED_OVERRIDE_REL = path.join(".garrison", "autonomy-seed.json");

/** GARRISON_HOME, resolved the way every other reader of that queue resolved it
 *  before the mesh (improver/lib/feedback-signals.mjs garrisonHome,
 *  probe-store.queuePath, the gateway's improverQueuePath). One endpoint has
 *  replaced the four spellings of one path; this stays for the other files that
 *  still live under the home. */
export function garrisonHome(explicit = null) {
  const given = typeof explicit === "string" ? explicit.trim() : "";
  if (given) return given;
  const env = process.env.GARRISON_HOME;
  return env && env.trim().length ? env.trim() : path.join(os.homedir(), ".garrison");
}

// ── 1. The evidence fold ────────────────────────────────────────────────────
//
// Ported field-for-field from src/lib/routing-tracks.ts. The comments there
// explain WHY each field is read the way it is; the short version is that every
// name below is the PRODUCER's, and inventing a friendlier one is how the fold
// silently returned zero evidence for months while its tests passed on fixtures
// in a shape nothing has ever written.

const str = (v) => (typeof v === "string" && v.trim().length > 0 ? v : null);

/** A record's sub-map, or an empty one. Anything that is not a plain object is
 *  treated as absent rather than indexed into: these lines come off a shared
 *  append-only log that several writers and the occasional hand edit touch. */
const submap = (v) => (!v || typeof v !== "object" || Array.isArray(v) ? {} : v);

/** The `provenance` stamp buildVerdictRecord writes. The queue also carries
 *  `override` records from the gateway and `probe` / `retrospective` records from
 *  the Improver: real evidence about other things, whose `answer` is free-ish
 *  text rather than this closed vocabulary, and which must never be read here. */
export const VERDICT_PROVENANCE = "decision-verdict";

/** Turn one feedback-queue line into evidence. */
export function evidenceFromVerdict(raw) {
  if (!raw || typeof raw !== "object") return [];
  if (str(raw.provenance) !== VERDICT_PROVENANCE) return []; // another producer's record
  const verdict = str(raw.answer);
  // The vocabulary is CLOSED (right | wrong | unsure). Anything else is not a
  // verdict and must not fall through to the "wrong" branch.
  if (verdict !== "right" && verdict !== "wrong") return []; // incl. "unsure": not evidence
  const at = str(raw.timestamp);
  const original = submap(raw.original);
  const applied = submap(raw.applied);
  // The shape is what the router DECIDED, never the counterfactual: evidence
  // about a bad call belongs on the track of the shape that was chosen. The duty
  // fallback covers the records written before `original` carried the flow.
  const shape = str(original.flow) ?? str(original.duty) ?? "unknown";

  if (verdict === "right") {
    return [
      { category: "flow", shape, signal: "explicit-confirmation", at },
      { category: "level", shape, signal: "explicit-confirmation", at }
    ];
  }
  const out = [];
  if (str(applied.flow)) out.push({ category: "flow", shape, signal: "explicit-negative", at });
  if (str(applied.tier) || str(applied.duty)) {
    out.push({ category: "level", shape, signal: "explicit-negative", at });
  }
  // A "wrong" that named neither category still counts against both: the user
  // said the call was wrong without saying which half caused it, and being told
  // it was wrong is information even without the answer.
  if (!out.length) {
    out.push(
      { category: "flow", shape, signal: "explicit-negative", at },
      { category: "level", shape, signal: "explicit-negative", at }
    );
  }
  return out;
}

/** Turn one decisions.jsonl record into evidence. */
export function evidenceFromDecision(raw) {
  if (!raw || typeof raw !== "object") return [];
  const at = str(raw.at);
  const shape = str(raw.flow) ?? str(raw.duty) ?? str(raw.taskType) ?? "unknown";
  if (str(raw.kind) === "escalation" && raw.applied === true) {
    return [{ category: "level", shape, signal: "escalation", at }];
  }
  if (str(raw.via) === "turn-override") {
    // A pin set before the run. Which dimension it corrects is what it pinned.
    // NOTE the omission that matters: a `projectDefaulted` pin is NOT a human
    // override, and the shell's fold does not read one either - only `via ===
    // "turn-override"` records reach this branch at all.
    const out = [];
    if (str(raw.flow)) out.push({ category: "flow", shape, signal: "manual-override", at });
    if (raw.level !== undefined && raw.level !== null) {
      out.push({ category: "level", shape, signal: "manual-override", at });
    }
    return out;
  }
  return [];
}

function parseJsonl(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // A malformed line is skipped, never fatal: this is a read path over an
      // append-only log that several writers share.
    }
  }
  return out;
}

// ── 2. The delete contract, read side (PRE-MESH parser) ─────────────────────
//
// §8.3 needs a wrong inference to be deletable, and the whole point of deriving
// tracks rather than counting them is that deleting the record deletes its
// effect on the band. The Signals view's delete appends a tombstone naming the
// record's key; every reader drops what a tombstone names. That join now runs in
// the service (GET /v1/feedback), so `readEvidence` above never sees a deleted
// record and this parser is off the live path.
//
// It survives for the one job SQL cannot do: reading a leftover
// `feedback-queue.jsonl(.pre-mesh)`. Its two key derivations must therefore stay
// byte-identical to improver/lib/feedback-signals.mjs (keyForRecord /
// derivedKeyForLine), to routing-tracks.ts, and to the importer that computed
// the `legacy_key` column for every id-less historical record. Cross-fitting
// imports are forbidden, so the FORMAT is the shared thing and the parity tests
// are what keep the copies honest.

export const TOMBSTONE_KIND = "tombstone";
export const DERIVED_KEY_PREFIX = "raw:";

export function derivedKeyForLine(rawLine) {
  return `${DERIVED_KEY_PREFIX}${createHash("sha256").update(String(rawLine ?? "").trim()).digest("hex").slice(0, 32)}`;
}

function keyForLine(record, rawLine) {
  const id = record && typeof record === "object" && typeof record.id === "string" ? record.id.trim() : "";
  return id.length ? id : derivedKeyForLine(rawLine);
}

/** Parse the feedback queue, dropping every record a tombstone deletes. */
export function parseFeedbackQueue(text) {
  const rows = [];
  const deleted = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let record;
    try {
      record = JSON.parse(t);
    } catch {
      continue;
    }
    if (record && typeof record === "object" && record.kind === TOMBSTONE_KIND) {
      if (typeof record.target === "string" && record.target.trim()) deleted.add(record.target.trim());
      continue; // a tombstone is not itself evidence
    }
    rows.push({ record, key: keyForLine(record, t) });
  }
  return rows.filter((row) => !deleted.has(row.key)).map((row) => row.record);
}

// ── 3. Shape normalisation + burst collapse ─────────────────────────────────

/** Retired duty -> successor, so a shape read off an old record does not appear
 *  as a separate track from the duty that absorbed it. */
export const SHAPE_ALIASES = Object.freeze({ code: "implement" });
export const adoptShape = (shape) => SHAPE_ALIASES[shape] ?? shape;

/** Seconds within which repeated identical evidence counts once. The live log
 *  holds hundreds of `image` turn-overrides at ~15s intervals - one machine loop
 *  pinning the duty on every call, not a person correcting the router hundreds of
 *  times. Counting DISTINCT OCCASIONS is the honest measure. */
export const BURST_WINDOW_SECONDS = 300;

export function collapseBursts(evidence, windowSeconds = BURST_WINDOW_SECONDS) {
  const lastAt = new Map();
  const out = [];
  for (const e of evidence || []) {
    const key = `${e.category}|${e.shape}|${e.signal}`;
    const t = e.at ? Date.parse(e.at) : NaN;
    if (!Number.isFinite(t)) {
      // No usable timestamp: keep it rather than guess. Dropping evidence is
      // worse than over-counting one record.
      out.push(e);
      continue;
    }
    const prev = lastAt.get(key);
    if (prev !== undefined && Math.abs(t - prev) < windowSeconds * 1000) continue;
    lastAt.set(key, t);
    out.push(e);
  }
  return out;
}

async function readTextTolerant(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return ""; // absent / unreadable reads as no evidence, never as an error
  }
}

async function readJsonTolerant(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// One client per gateway process (this module is dynamically imported into it),
// built lazily so importing it never requires the node to be enrolled.
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

const FEEDBACK_READ_LIMIT = 5000;
const FEEDBACK_PAGE = 500;

/** Every live feedback record, oldest first. The service's reader has already
 *  dropped the rows a tombstone names — the half this fold depends on, since
 *  deleting the record is what deletes the inference. */
async function readFeedbackRecords(client) {
  const c = stateClient(client);
  const out = [];
  let sinceSeq = 0;
  while (out.length < FEEDBACK_READ_LIMIT) {
    const size = Math.min(FEEDBACK_PAGE, FEEDBACK_READ_LIMIT - out.length);
    const page = await c.listFeedback({ sinceSeq, limit: size });
    if (!page.length) break;
    for (const row of page) out.push(row.payload ?? {});
    sinceSeq = page[page.length - 1].seq;
    // The tombstone join runs in SQL BEFORE the LIMIT, so a short page means the
    // scan reached the end, not that the rest was filtered away.
    if (page.length < size) break;
  }
  return out;
}

/**
 * Read every piece of evidence: the feedback queue from the state service, the
 * decisions log from the composition directory.
 *
 * An unreachable service THROWS rather than folding to zero evidence. The
 * gateway's `autonomyFor` catches it, logs `autonomy-consult-failed` and FAILS
 * OPEN — which is the documented behaviour of this seam, and strictly better
 * than silently computing a band from an evidence set that could not be loaded.
 */
export async function readEvidence({ compositionDir, garrisonHome: home = null, client = null } = {}) {
  void home; // the queue is no longer under the home; kept for call-site compatibility
  const decisionsFile = compositionDir ? path.join(compositionDir, DECISIONS_REL) : null;
  const [verdicts, decisions] = await Promise.all([
    readFeedbackRecords(client),
    decisionsFile ? readTextTolerant(decisionsFile) : Promise.resolve("")
  ]);
  const all = [
    ...verdicts.flatMap(evidenceFromVerdict),
    ...parseJsonl(decisions).flatMap(evidenceFromDecision)
  ].map((e) => ({ ...e, shape: adoptShape(e.shape) }));
  return collapseBursts(all);
}

// ── 4. The cold-start seed ──────────────────────────────────────────────────
//
// Loading order MIRRORS the shell's API route (src/app/api/orchestrator/autonomy):
// a composition's own .garrison/autonomy-seed.json wins, else the shipped seed.
// A missing or unreadable seed degrades to a COLD START, never to an error -
// asking too often is an annoyance, failing the consult would park real work.

export async function loadSeedEntries(compositionDir) {
  try {
    const doc =
      (compositionDir ? await readJsonTolerant(path.join(compositionDir, SEED_OVERRIDE_REL)) : null) ??
      (await readJsonTolerant(SHIPPED_SEED_PATH));
    if (!doc) return [];
    return expandAutonomySeed(doc);
  } catch {
    return [];
  }
}

// ── 5. Tracks ───────────────────────────────────────────────────────────────

/**
 * Fold evidence into a track per (category, shape) and report each one's band.
 * Same output shape as the shell's summariseTracks, because the parity test
 * compares them field for field.
 */
export async function summariseTracks({
  compositionDir,
  garrisonHome: home = null,
  seed = [],
  action = "code-change",
  now = null
} = {}) {
  const evidence = await readEvidence({ compositionDir, garrisonHome: home });
  const tracks = seedFromHistory(seed);
  const signals = {};

  for (const e of evidence) {
    const key = trackKey(e.category, e.shape);
    tracks[key] = recordSignal(tracks[key] ?? emptyTrack(), e.signal, { at: e.at });
    signals[key] ??= {};
    signals[key][e.signal] = (signals[key][e.signal] ?? 0) + 1;
  }

  return Object.entries(tracks)
    .map(([key, track]) => {
      const sep = key.indexOf(":");
      return {
        category: key.slice(0, sep),
        shape: key.slice(sep + 1),
        observations: Number(track.observations ?? 0),
        signals: signals[key] ?? {},
        track,
        band: bandFor(track, { action, now })
      };
    })
    .sort((a, b) => a.band.confidence - b.band.confidence || a.shape.localeCompare(b.shape));
}

// ── 6. The ask budget ───────────────────────────────────────────────────────
//
// A dated counter of questions ACTUALLY POSED, so the anti-fatigue rule in
// shouldAsk has a number to work with across gateway restarts. Deliberately not
// folded into the evidence logs: it is bookkeeping about the conversation, not
// evidence about the router, and deleting it should reset the day rather than
// rewrite history.
//
// Read-modify-write with no lock. The failure mode of a lost increment is one
// extra question on a day that already asked five, which is not worth a lock file
// on the dispatch path.

/** The day a timestamp belongs to, in the local calendar the user lives in. */
export function budgetDay(now = null) {
  const d = now ? new Date(now) : new Date();
  const t = Number.isFinite(d.getTime()) ? d : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

export async function readAskBudget(compositionDir, { now = null } = {}) {
  const day = budgetDay(now);
  if (!compositionDir) return { date: day, asked: 0 };
  const doc = await readJsonTolerant(path.join(compositionDir, ASK_BUDGET_REL));
  if (!doc || typeof doc !== "object" || doc.date !== day) return { date: day, asked: 0 };
  const asked = Number(doc.asked);
  return { date: day, asked: Number.isFinite(asked) && asked > 0 ? Math.trunc(asked) : 0 };
}

/**
 * Bump the counter. The caller invokes this ONLY when a question was actually
 * posed - counting intent rather than delivery is how a rate limit starts
 * suppressing questions nobody ever saw.
 */
export async function recordAsked(compositionDir, { now = null } = {}) {
  if (!compositionDir) return { date: budgetDay(now), asked: 0 };
  const current = await readAskBudget(compositionDir, { now });
  const next = { date: current.date, asked: current.asked + 1, at: now ?? new Date().toISOString() };
  try {
    await fs.mkdir(path.join(compositionDir, ".garrison"), { recursive: true });
    await fs.writeFile(path.join(compositionDir, ASK_BUDGET_REL), JSON.stringify(next) + "\n", "utf8");
  } catch {
    // A budget we cannot persist means the next question is not counted. That
    // over-asks slightly; refusing to ask because a counter would not write is
    // strictly worse.
  }
  return next;
}

// ── 7. The answer, written back as evidence ─────────────────────────────────
//
// A "go" on a held card is the strongest ordinary thing the user can say about a
// routing decision: they looked at the proposal and confirmed it. If that word
// left no trace, the router would ask the same question about the same shape
// forever - the hold would be a tax rather than a learning loop.
//
// It is written as a VERDICT record on the shared feedback queue, not as a new
// record type, because the verdict shape is what BOTH folds (this module and the
// shell's routing-tracks.ts) already read as `explicit-confirmation`, and what
// the Signals view already renders and can already tombstone. A new shape would
// need three readers taught about it, and would be invisible to the delete
// contract until they were.
//
// The id format is the one documented in improver/lib/feedback-signals.mjs.
// Cross-fitting imports are forbidden, so - exactly as that file prescribes -
// this producer carries its own minter pointing back at the definition.

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

/**
 * The record a "go" writes. Byte-compatible with buildVerdictRecord
 * (src/lib/decision-verdicts.ts): same `question`, same closed `answer`
 * vocabulary, same `provenance`, and `original` filled from the resolution that
 * was CONFIRMED - which is the field both folds key the shape on.
 *
 * `decision_id` is carried when the caller kept the routing decision's id (the
 * held card does), and omitted otherwise rather than filled with a plausible
 * substitute: the Signals view reads it as nullable, and a card id wearing a
 * decision id's field name is a lie that would survive in the log forever.
 */
export function buildGoConfirmationRecord({ flow = null, duty = null, level = null, tier = null, decisionId = null, sessionId = null, at = null } = {}) {
  const stamp = at ?? new Date().toISOString();
  const original = {};
  if (str(flow)) original.flow = flow;
  if (str(duty)) original.duty = duty;
  if (str(tier)) original.tier = tier;
  if (Number.isInteger(level)) original.level = level;
  return {
    id: mintFeedbackId(stamp),
    ...(str(sessionId) ? { session_id: sessionId } : {}),
    area: "orchestrator",
    question: "decision-verdict",
    answer: "right",
    ...(str(decisionId) ? { decision_id: decisionId } : {}),
    ...(Object.keys(original).length ? { original } : {}),
    timestamp: stamp,
    provenance: VERDICT_PROVENANCE
  };
}

/**
 * The record a CORRECTION writes - the other answer the hold can receive.
 *
 * Same verdict shape as the go, with the closed vocabulary's other value: the
 * user looked at the proposal and said it was wrong. `original` is the route the
 * router PROPOSED (both folds key the track on it, so the evidence lands on the
 * shape that was chosen, never on the counterfactual) and `applied` names what
 * the user corrected TOWARD, which is what evidenceFromVerdict reads to decide
 * whether the flow, the level, or both were the wrong half.
 *
 * Without this, a hold could only ever teach the router that it was right: the
 * go wrote evidence and the correction wrote nothing, so a shape the user kept
 * correcting would look, in the tracks, like a shape nobody had ever disputed.
 */
export function buildCorrectionRecord({ original = {}, applied = {}, decisionId = null, sessionId = null, at = null } = {}) {
  const stamp = at ?? new Date().toISOString();
  const route = (src) => {
    const out = {};
    if (str(src?.flow)) out.flow = src.flow;
    if (str(src?.duty)) out.duty = src.duty;
    if (str(src?.tier)) out.tier = src.tier;
    if (Number.isInteger(src?.level)) out.level = src.level;
    return out;
  };
  return {
    id: mintFeedbackId(stamp),
    ...(str(sessionId) ? { session_id: sessionId } : {}),
    area: "orchestrator",
    question: "decision-verdict",
    answer: "wrong",
    ...(str(decisionId) ? { decision_id: decisionId } : {}),
    original: route(original),
    applied: route(applied),
    timestamp: stamp,
    provenance: VERDICT_PROVENANCE
  };
}

// ── 8. The consult ──────────────────────────────────────────────────────────

const BAND_ORDER = { ask: 0, "act-revert": 1, "act-inform": 2 };

/** The worst (least free) of a set of bands. Freedom is granted per category and
 *  the DECISION is one thing, so the whole decision moves at the pace of its
 *  least-trusted half. */
export function worstBand(bands) {
  let worst = "act-inform";
  for (const b of bands) {
    if (BAND_ORDER[b] === undefined) continue;
    if (BAND_ORDER[b] < BAND_ORDER[worst]) worst = b;
  }
  return worst;
}

/** One route, in the vocabulary the board and the thread already use. Extracted
 *  from askQuestion so the gateway's re-ask after a CORRECTION names the new
 *  route in exactly the words the first ask named the old one - two spellings of
 *  the same route in one conversation reads as two different proposals. */
export function routePhrase({ flow = null, duty = null, level = null } = {}) {
  return [
    flow ? `the ${flow} flow` : null,
    duty ? `duty ${duty}` : null,
    Number.isInteger(level) ? `level ${level}` : null
  ]
    .filter(Boolean)
    .join(", ");
}

/** The one sentence the router says when it has to ask. Names what it proposes
 *  to do, in the vocabulary the board and the thread already use, and states the
 *  two ways to answer. */
export function askQuestion({ flow, duty, level, band, reason } = {}) {
  const what = routePhrase({ flow, duty, level });
  const why =
    reason === "cold-start"
      ? "I have no track record on this shape yet"
      : reason === "post-demotion"
        ? "the last call on this shape was corrected"
        : reason === "near-boundary"
          ? "this shape sits right on a confidence threshold"
          : reason === "recurring-override"
            ? "you have overridden this shape repeatedly"
            : "I am not confident enough on this shape yet";
  const head = what ? `I would run this as ${what}` : "I would run this as routed";
  return `${head} - ${why}${band === "ask" ? "" : ` (${band})`}. Reply go to proceed, or correct me.`;
}

/**
 * Consult the bands for one routing decision.
 *
 * Returns the per-category bands, the overall band the caller must obey, the
 * question to pose (when one is warranted), and the ask-budget state. It NEVER
 * throws and never decides on the caller's behalf: the gateway owns what "ask"
 * means for its own lane.
 *
 * `action` gates through the reversibility taxonomy inside bandFor - an
 * irreversible action never reaches act-inform however good the record is, so
 * callers pass the honest action class rather than the convenient one.
 */
export async function consultAutonomy({
  compositionDir,
  garrisonHome: home = null,
  decision = {},
  action = "code-change",
  thresholds = DEFAULT_THRESHOLDS,
  now = null,
  seed = null
} = {}) {
  const { flow = null, duty = null, level = null } = decision;
  // The shape a band is keyed on: the flow when the route resolved one, else the
  // duty - the SAME fallback both folds make when reading a record, which is what
  // keeps the consult reading the tracks the evidence actually built.
  const shape = adoptShape(str(flow) ?? str(duty) ?? "unknown");

  const seedEntries = Array.isArray(seed) ? seed : await loadSeedEntries(compositionDir);
  const evidence = await readEvidence({ compositionDir, garrisonHome: home });
  const tracks = seedFromHistory(seedEntries);
  for (const e of evidence) {
    const key = trackKey(e.category, e.shape);
    tracks[key] = recordSignal(tracks[key] ?? emptyTrack(), e.signal, { at: e.at });
  }

  const budget = await readAskBudget(compositionDir, { now });
  const decisions = {};
  let required = null; // a category whose BAND requires the question
  let informational = null; // a question asked for information value only
  let deferred = null; // an informational question the budget sent to the digest

  for (const category of CATEGORIES) {
    const track = tracks[trackKey(category, shape)] ?? emptyTrack();
    const resolved = bandFor(track, { thresholds, action, now });
    const ask = shouldAsk(track, { thresholds, askedToday: budget.asked, action, now });
    decisions[category] = {
      band: resolved.band,
      confidence: resolved.confidence,
      reversibility: resolved.reversibility,
      delaySeconds: resolved.delaySeconds,
      observations: track.observations || 0,
      reason: ask.reason ?? null
    };
    if (resolved.band === "ask" && ask.ask) required ??= { category, reason: ask.reason ?? "low-confidence" };
    else if (ask.ask) informational ??= { category, reason: ask.reason };
    else if (ask.defer) deferred ??= { category, reason: ask.reason };
  }

  const band = worstBand(CATEGORIES.map((c) => decisions[c].band));
  const chosen = required ?? informational ?? null;
  return {
    shape,
    band,
    decisions,
    /** True when the DECISION may not proceed until it is answered. */
    ask: Boolean(required),
    /** A question worth posing alongside work that proceeds anyway. */
    informational: Boolean(!required && informational),
    /** A real question the budget sent to the digest; no question is posed. */
    deferred: deferred ? deferred.reason ?? "over-budget" : null,
    reason: chosen?.reason ?? null,
    question: chosen
      ? askQuestion({ flow, duty, level, band, reason: chosen.reason })
      : null,
    askBudget: { askedToday: budget.asked, date: budget.date, limit: thresholds.maxQuestionsPerDay ?? DEFAULT_THRESHOLDS.maxQuestionsPerDay },
    seeded: seedEntries.length > 0
  };
}
